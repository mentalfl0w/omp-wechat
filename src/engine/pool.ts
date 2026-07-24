/**
 * SessionPool — manages ChatSession instances per WeChat chat.
 *
 * Encapsulates the chat→session map, LRU eviction, and reply handler
 * injection. Thread-safe by virtue of JS single-threaded async.
 */
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { ChatSession } from "./session.js";

export interface PoolStatus {
  count: number;
  max: number;
  chats: Array<{ chatId: string; lastActive: number }>;
}

export class SessionPool {
  private pool = new Map<string, ChatSession>();
  private maxSessions: number;
  private replyHandler: (chatId: string, text: string) => void;

  constructor(maxSessions: number, replyHandler: (chatId: string, text: string) => void) {
    this.maxSessions = maxSessions;
    this.replyHandler = replyHandler;
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

    entry = await ChatSession.create(chatId, contextToken, config, this.replyHandler);
    this.pool.set(chatId, entry);
    return entry;
  }

  /** Inject a user message into the session for a chat. */
  async prompt(chatId: string, contextToken: string, text: string, config: AppConfig): Promise<void> {
    const entry = await this.ensure(chatId, contextToken, config);
    await entry.prompt(text);
  }

  /** Get the ChatSession for a chat (for command access). */
  get(chatId: string): ChatSession | undefined {
    return this.pool.get(chatId);
  }

  /** Get the latest context_token for a chat. */
  getContextToken(chatId: string): string {
    return this.pool.get(chatId)?.getContextToken() ?? "";
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
