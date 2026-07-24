/**
 * SessionStore — maps WeChat chat IDs to persistent session directories.
 *
 * Each WeChat chat gets its own session directory under
 * ~/.omp-wechat/sessions/<sanitized-chatId>/. The OMP SDK's
 * SessionManager writes JSONL history files there; on process restart,
 * continueRecent() resumes the conversation from disk.
 *
 * Also provides stale-session cleanup: directories whose newest file
 * hasn't been modified in N days are pruned.
 */
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "fs";
import { logger } from "../utils/logger.js";

const STATE_DIR = join(homedir(), ".omp-wechat");
const SESSIONS_DIR = join(STATE_DIR, "sessions");
const STALE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Sanitize a WeChat chat ID for use as a directory name.
 * WeChat IDs contain @ and _ which are safe, but we strip any
 * path separators and limit length.
 */
export function sanitizeChatId(chatId: string): string {
  return chatId
    .replace(/[^a-zA-Z0-9_@.-]/g, "_")
    .slice(0, 200);
}

/** Get the session directory for a WeChat chat. */
export function sessionDirFor(chatId: string): string {
  return join(SESSIONS_DIR, sanitizeChatId(chatId));
}

/** Ensure the sessions root directory exists. */
export function ensureSessionsDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

/**
 * Remove session directories whose newest file hasn't been touched
 * in over STALE_THRESHOLD_MS. Called periodically by the bridge.
 * Returns the count of removed directories.
 */
export function cleanupStaleSessions(): number {
  if (!existsSync(SESSIONS_DIR)) return 0;

  const now = Date.now();
  let removed = 0;

  for (const entry of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const dir = join(SESSIONS_DIR, entry.name);
    let newestMtime = 0;

    try {
      for (const file of readdirSync(dir)) {
        const mtime = statSync(join(dir, file)).mtimeMs;
        if (mtime > newestMtime) newestMtime = mtime;
      }
    } catch {
      // Can't read the directory — skip it.
      continue;
    }

    // Empty directory or stale → remove.
    if (newestMtime === 0 || now - newestMtime > STALE_THRESHOLD_MS) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed++;
        logger.info(`Cleaned up stale session dir: ${entry.name}`);
      } catch (err) {
        logger.warn(`Failed to cleanup session dir ${entry.name}: ${err}`);
      }
    }
  }

  if (removed > 0) {
    logger.info(`Session cleanup: removed ${removed} stale session(s)`);
  }

  return removed;
}

/**
 * Remove ALL session directories. Used by /wechat clear.
 * Returns the count of removed directories.
 */
export function clearAllSessions(): number {
  if (!existsSync(SESSIONS_DIR)) return 0;

  let removed = 0;
  for (const entry of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      rmSync(join(SESSIONS_DIR, entry.name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn(`Failed to remove session dir ${entry.name}: ${err}`);
    }
  }

  return removed;
}
