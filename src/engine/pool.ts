import type { SessionEntry } from "./session.js";
import { createSession } from "./session.js";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";

let maxSessions = 50;
const pool = new Map<string, SessionEntry>();

let replyHandler: (chatId: string, text: string) => void = () => {};

export function setReplyHandler(fn: (chatId: string, text: string) => void): void {
  replyHandler = fn;
}

export function setMaxSessions(n: number): void {
  maxSessions = n;
}

export async function ensureSession(
  chatId: string,
  contextToken: string,
  config: AppConfig,
): Promise<SessionEntry> {
  let entry = pool.get(chatId);
  if (entry) {
    entry.contextToken = contextToken;
    entry.lastActive = Date.now();
    return entry;
  }

  // LRU eviction
  if (pool.size >= maxSessions) {
    evictOldest();
  }

  entry = await createSession(chatId, contextToken, config, replyHandler);
  pool.set(chatId, entry);
  return entry;
}

/** Inject a user message into the session for a chat */
export async function promptSession(
  chatId: string,
  contextToken: string,
  text: string,
  config: AppConfig,
): Promise<void> {
  const entry = await ensureSession(chatId, contextToken, config);
  await entry.session.prompt(text);
}

/** Get the latest context_token for a chat */
export function getContextToken(chatId: string): string {
  return pool.get(chatId)?.contextToken ?? "";
}

function evictOldest(): void {
  let oldestId: string | null = null;
  let oldestTime = Infinity;

  for (const [id, entry] of pool) {
    if (entry.lastActive < oldestTime) {
      oldestTime = entry.lastActive;
      oldestId = id;
    }
  }

  if (oldestId) {
    const entry = pool.get(oldestId);
    if (entry) {
      entry.session.dispose().catch((err: unknown) => {
        logger.warn(`Session dispose error (${oldestId}): ${err}`);
      });
    }
    pool.delete(oldestId);
    logger.info(`LRU evicted session: ${oldestId}`);
  }
}

/** Get pool status (for the status command) */
export function getPoolStatus(): {
  count: number;
  max: number;
  chats: Array<{ chatId: string; lastActive: number }>;
} {
  const chats = Array.from(pool.entries()).map(([chatId, entry]) => ({
    chatId,
    lastActive: entry.lastActive,
  }));
  return { count: pool.size, max: maxSessions, chats };
}

/** Dispose all sessions (for graceful shutdown) */
export async function disposeAll(): Promise<void> {
  const disposals = Array.from(pool.values()).map((entry) =>
    entry.session.dispose().catch((err: unknown) => {
      logger.warn(`Session dispose error: ${err}`);
    }),
  );
  await Promise.all(disposals);
  pool.clear();
}
