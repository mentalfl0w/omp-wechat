/**
 * SessionPool — manages ChatSession instances per WeChat chat.
 *
 * Encapsulates the chat→session map, LRU eviction, and reply handler
 * injection. Thread-safe by virtue of JS single-threaded async.
 */
import type { AppConfig } from "../config.js";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "../utils/logger.js";
import { ChatSession } from "./session.js";
import { removeSessionDir } from "./session-store.js";

export interface PoolStatus {
  count: number;
  max: number;
  chats: Array<{ chatId: string; lastActive: number }>;
}

export class SessionPool {
  private pool = new Map<string, ChatSession>();
  private maxSessions: number;
  private replyHandler: (chatId: string, text: string) => void;
  private fileHandler: (chatId: string, files: string[]) => void;

  constructor(
    maxSessions: number,
    replyHandler: (chatId: string, text: string) => void,
    fileHandler: (chatId: string, files: string[]) => void,
  ) {
    this.maxSessions = maxSessions;
    this.replyHandler = replyHandler;
    this.fileHandler = fileHandler;
  }

  setMaxSessions(n: number): void {
    this.maxSessions = n;
  }

  /** Get or create a ChatSession for a chat. */
  async ensure(chatId: string, contextToken: string, config: AppConfig): Promise<ChatSession> {
    let entry = this.pool.get(chatId);
    if (entry) {
      entry.setContextToken(contextToken);
      return entry;
    }

    // LRU eviction
    if (this.pool.size >= this.maxSessions) {
      this.evictOldest();
    }

    entry = await ChatSession.create(chatId, contextToken, config, this.replyHandler, this.fileHandler);
    this.pool.set(chatId, entry);
    return entry;
  }

  /** Inject a user message (with optional images) into the session for a chat. */
  async prompt(
    chatId: string,
    contextToken: string,
    text: string,
    config: AppConfig,
    images?: ImageContent[],
  ): Promise<void> {
    const entry = await this.ensure(chatId, contextToken, config);
    await entry.prompt(text, images);
  }

  /** Get the ChatSession for a chat (for command access). */
  get(chatId: string): ChatSession | undefined {
    return this.pool.get(chatId);
  }

  /** Dispose and remove a session so the next message creates a fresh one. */
  async resetSession(chatId: string): Promise<void> {
    const entry = this.pool.get(chatId);
    if (entry) {
      await entry.dispose();
      this.pool.delete(chatId);
    }
    // Also remove the on-disk session directory — otherwise
    // SessionManager.continueRecent() on the next ensure() would
    // resume the session we just disposed, defeating /new.
    removeSessionDir(chatId);
  }

  /** Get the latest context_token for a chat. */
  getContextToken(chatId: string): string {
    return this.pool.get(chatId)?.getContextToken() ?? "";
  }

  /** Whether the session for a chat has a vision-capable model. */
  supportsVision(chatId: string): boolean {
    return this.pool.get(chatId)?.supportsVision() ?? false;
  }

  private evictOldest(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, entry] of this.pool) {
      const t = entry.getLastActive();
      if (t < oldestTime) {
        oldestTime = t;
        oldestId = id;
      }
    }

    if (oldestId) {
      const entry = this.pool.get(oldestId);
      if (entry) {
        entry.dispose().catch((err: unknown) => {
          logger.warn(`Session dispose error (${oldestId}): ${err}`);
        });
      }
      this.pool.delete(oldestId);
      logger.info(`LRU evicted session: ${oldestId}`);
    }
  }

  getPoolStatus(): PoolStatus {
    const chats = Array.from(this.pool.entries()).map(([chatId, entry]) => ({
      chatId,
      lastActive: entry.getLastActive(),
    }));
    return { count: this.pool.size, max: this.maxSessions, chats };
  }

  /** Dispose all sessions (for graceful shutdown). */
  async disposeAll(): Promise<void> {
    const disposals = Array.from(this.pool.values()).map((entry) =>
      entry.dispose().catch((err: unknown) => {
        logger.warn(`Session dispose error: ${err}`);
      }),
    );
    await Promise.all(disposals);
    this.pool.clear();
  }
}
