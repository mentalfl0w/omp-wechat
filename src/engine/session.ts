/**
 * ChatSession — wraps an OMP AgentSession for a single WeChat chat.
 *
 * Encapsulates session creation, reply subscription, and prompt injection.
 * Each WeChat chat gets one ChatSession instance; the SessionPool owns
 * the lifecycle (create / evict / dispose).
 */
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { sessionDirFor, ensureSessionsDir } from "./session-store.js";

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

  private constructor(
    session: AgentSession,
    chatId: string,
    contextToken: string,
  ) {
    this.session = session;
    this.chatId = chatId;
    this.contextToken = contextToken;
    this.lastActive = Date.now();
  }

  /** Create a new AgentSession bound to a WeChat chat. */
  static async create(
    chatId: string,
    contextToken: string,
    config: AppConfig,
    onReply: (chatId: string, text: string) => void,
  ): Promise<ChatSession> {
    logger.info(`Creating session: ${chatId}`);

    // Persist session to disk so AI context survives process restarts.
    // Each WeChat chat gets its own session directory; continueRecent
    // resumes the last session if one exists, or creates a new one.
    ensureSessionsDir();
    const sessionDir = sessionDirFor(chatId);
    const sessionManager = await SessionManager.continueRecent(
      process.cwd(),
      sessionDir,
    );
    logger.info(`Session dir: ${sessionDir} (resumed=${sessionManager.getSessionFile() !== null})`);

    const { session, modelFallbackMessage } = await createAgentSession({
      sessionManager,
      enableMCP: false,
      enableLsp: false,
      systemPrompt: config.systemPrompt,
      // Pass model pattern (role alias or provider/id) to the SDK for
      // resolution against the user's OMP settings. Undefined = inherit
      // OMP global default.
      modelPattern: config.model,
    });

    if (modelFallbackMessage) {
      logger.warn(`Model fallback: ${modelFallbackMessage}`);
    }

    const wrapper = new ChatSession(session, chatId, contextToken);

    // Subscribe to assistant replies — forward text to the bridge.
    session.subscribe((event: AgentSessionEvent) => {
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

  /** Inject a user message into the AI session. */
  async prompt(text: string): Promise<void> {
    this.lastActive = Date.now();
    await this.session.prompt(text);
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
