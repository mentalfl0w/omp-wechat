/**
 * ChatSession — wraps an OMP AgentSession for a single WeChat chat.
 *
 * Encapsulates session creation, reply subscription, and prompt injection.
 * Each WeChat chat gets one ChatSession instance; the SessionPool owns
 * the lifecycle (create / evict / dispose).
 */
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { sessionDirFor, ensureSessionsDir, outboxDirFor } from "./session-store.js";
import { mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** System-prompt block teaching the AI how to deliver files via WeChat. */
function outboxInstructions(outboxDir: string): string {
  return `## File delivery to WeChat

You can send files (documents, spreadsheets, images, PDFs, code, etc.) to the WeChat user.

Rules:
- Write each final deliverable to the outbox directory:
  ${outboxDir}
- Only final deliverables belong there — never intermediate or scratch files.
- You may write multiple files; every new file in the outbox is delivered to the user after your turn.
- Mention the file name(s) in your reply so the user knows what to expect.`;
}

/** Extract plain text from an assistant message's content blocks. */
function extractAssistantText(message: { content: unknown }): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}

export class ChatSession {
  readonly session: AgentSession;
  readonly chatId: string;
  private contextToken: string;
  private lastActive: number;
  private replyCount = 0;
  private readonly outboxDir: string;
  private readonly sendFilesEnabled: boolean;
  private readonly onFiles: (chatId: string, files: string[]) => void;
  private outboxSnapshot = new Map<string, { size: number; mtimeMs: number }>();

  private constructor(
    session: AgentSession,
    chatId: string,
    contextToken: string,
    outboxDir: string,
    sendFilesEnabled: boolean,
    onFiles: (chatId: string, files: string[]) => void,
  ) {
    this.session = session;
    this.chatId = chatId;
    this.contextToken = contextToken;
    this.lastActive = Date.now();
    this.outboxDir = outboxDir;
    this.sendFilesEnabled = sendFilesEnabled;
    this.onFiles = onFiles;
  }

  /** Create a new AgentSession bound to a WeChat chat. */
  static async create(
    chatId: string,
    contextToken: string,
    config: AppConfig,
    onReply: (chatId: string, text: string) => void,
    onFiles: (chatId: string, files: string[]) => void,
  ): Promise<ChatSession> {
    logger.info(`Creating session: ${chatId}`);

    const outboxDir = outboxDirFor(chatId, config.outboxDir);
    const sendFilesEnabled = config.sendFiles !== false;
    if (sendFilesEnabled) {
      try {
        mkdirSync(outboxDir, { recursive: true });
      } catch (err) {
        logger.warn(`[${chatId}] Could not create outbox dir ${outboxDir}:`, err);
      }
    }

    // Persist session to disk so AI context survives process restarts.
    // Each WeChat chat gets its own session directory; continueRecent
    // resumes the last session if one exists, or creates a new one.
    ensureSessionsDir();
    const sessionDir = sessionDirFor(chatId);
    const sessionManager = await SessionManager.continueRecent(
      config.cwd || process.cwd(),
      sessionDir,
    );
    logger.info(`Session dir: ${sessionDir} (resumed=${sessionManager.getSessionFile() !== null})`);

    const { session, modelFallbackMessage } = await createAgentSession({
      sessionManager,
      enableMCP: false,
      enableLsp: false,
      // Append outbox delivery instructions when file delivery is enabled
      systemPrompt: sendFilesEnabled
        ? `${config.systemPrompt}\n\n${outboxInstructions(outboxDir)}`
        : config.systemPrompt,
      // Pass model pattern (role alias or provider/id) to the SDK for
      // resolution against the user's OMP settings. Undefined = inherit
      // OMP global default.
      modelPattern: config.model,
    });
    // WeChat is a lightweight chat surface — disable the advisor to avoid
    // burning tokens on second-model review even if the user enabled it globally.
    session.setAdvisorEnabled(false);

    if (modelFallbackMessage) {
      logger.warn(`Model fallback: ${modelFallbackMessage}`);
    }

    const wrapper = new ChatSession(
      session,
      chatId,
      contextToken,
      outboxDir,
      sendFilesEnabled,
      onFiles,
    );
    // Log vision capability so operators know if image input is supported.
    const visionRole = session.settings.getModelRole("vision");
    logger.info(`[${chatId}] Model: ${session.model?.id ?? "unknown"}, vision role: ${visionRole ?? "(not configured)"}`);

    // Subscribe to assistant replies — forward text to the bridge.
    session.subscribe((event: AgentSessionEvent) => {
      // turn_end fires after every tool call in the turn has finished,
      // so outbox diffing here sees the complete set of written files.
      if (event.type === "turn_end") {
        wrapper.flushOutbox();
        return;
      }
      if (event.type !== "message_end") return;
      if (event.message.role !== "assistant") return;

      wrapper.replyCount++;
      const text = extractAssistantText(event.message);
      logger.info(`[${chatId}] message_end #${wrapper.replyCount}: ${text.slice(0, 100)}`);
      if (text) {
        onReply(chatId, text);
      }
    });

    return wrapper;
  }

  /** Inject a user message (with optional images) into the AI session. */
  async prompt(text: string, images?: ImageContent[]): Promise<void> {
    this.lastActive = Date.now();
    // Snapshot the outbox before the turn starts; new/changed files after
    // turn_end are the turn's deliverables.
    this.outboxSnapshot = this.snapshotOutbox();
    await this.session.prompt(text, images?.length ? { images } : undefined);
  }

  /**
   * Diff the outbox against the pre-turn snapshot and hand new/changed
   * files to the bridge for delivery. Runs synchronously on turn_end so
   * the next turn's snapshot can never miss a file.
   */
  private flushOutbox(): void {
    if (!this.sendFilesEnabled) return;

    const current = this.snapshotOutbox();
    const fresh: string[] = [];
    for (const [name, stat] of current) {
      const prev = this.outboxSnapshot.get(name);
      if (!prev || prev.size !== stat.size || prev.mtimeMs !== stat.mtimeMs) {
        fresh.push(join(this.outboxDir, name));
      }
    }
    this.outboxSnapshot = current;

    if (fresh.length > 0) {
      logger.info(`[${this.chatId}] Outbox: ${fresh.length} new file(s) for delivery`);
      this.onFiles(this.chatId, fresh);
    }
  }

  /** Snapshot (name → size+mtime) of regular files in the outbox. */
  private snapshotOutbox(): Map<string, { size: number; mtimeMs: number }> {
    const map = new Map<string, { size: number; mtimeMs: number }>();
    try {
      for (const name of readdirSync(this.outboxDir)) {
        try {
          const st = statSync(join(this.outboxDir, name));
          if (st.isFile()) map.set(name, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // Skip unreadable entries
        }
      }
    } catch {
      // Outbox dir missing — nothing to snapshot
    }
    return map;
  }

  /** Whether OMP has a vision model role configured. */
  supportsVision(): boolean {
    return this.session.settings.getModelRole("vision") !== undefined;
  }


  /** Update the context token (from the latest inbound message). */
  setContextToken(token: string): void {
    this.contextToken = token;
  }

  /** Get the current context token (for sending replies). */
  getContextToken(): string {
    return this.contextToken;
  }

  /** Check idle age for LRU eviction. */
  getLastActive(): number {
    return this.lastActive;
  }

  /** Tear down the underlying AI session. */
  async dispose(): Promise<void> {
    await this.session.dispose();
  }
}
