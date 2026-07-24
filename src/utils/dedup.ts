/**
 * Cross-process message deduplication.
 *
 * iLink uses at-least-once delivery: when the poll-loop process is killed
 * mid-flight (OMP restarts sessions frequently), the server re-delivers
 * messages that weren't acknowledged within its retry window. This causes
 * the same user message to be processed twice — producing two AI replies.
 *
 * We persist seen message fingerprints (with timestamps) to a file so that
 * a successor process can skip a message already handled by its
 * predecessor. Entries expire after DEDUP_TTL_MS to bound memory and
 * avoid blocking a user who legitimately resends the same text much later.
 *
 * Only messages carrying a server `create_time_ms` are deduped: that
 * field is stable across re-deliveries of the same message, so it is the
 * only safe collision key. Without it we'd risk false positives on
 * genuinely separate messages with identical text.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "./logger.js";

const STATE_DIR = join(homedir(), ".omp-wechat");
const DEDUP_FILE = join(STATE_DIR, "seen_msgs.json");
const MAX_ENTRIES = 500;
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes — covers iLink re-delivery window

interface SeenEntry {
  key: string;
  ts: number;
}

let entries: SeenEntry[] | null = null;

function load(): SeenEntry[] {
  if (entries) return entries;
  try {
    const raw = readFileSync(DEDUP_FILE, "utf8");
    const arr = JSON.parse(raw);
    entries = Array.isArray(arr) ? arr : [];
  } catch {
    entries = [];
  }
  return entries;
}

function gc(s: SeenEntry[]): void {
  const now = Date.now();
  const fresh = s.filter((e) => now - e.ts < DEDUP_TTL_MS);
  if (fresh.length < s.length) {
    s.length = 0;
    s.push(...fresh);
  }
}

function persist(s: SeenEntry[]): void {
  let arr = s.slice();
  if (arr.length > MAX_ENTRIES) arr = arr.slice(arr.length - MAX_ENTRIES);
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const tmp = DEDUP_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(arr) + "\n", { mode: 0o600 });
    renameSync(tmp, DEDUP_FILE);
  } catch (err) {
    logger.debug(`dedup persist failed: ${err}`);
  }
}

/**
 * Build a stable fingerprint for an inbound message.
 * Returns null when `createTimeMs` is absent — without that stable
 * server timestamp we cannot safely distinguish a re-delivery from a
 * genuine resend, so we decline to dedup rather than risk a false drop.
 */
export function makeDedupKey(
  senderId: string,
  createTimeMs: number | undefined,
  text: string,
): string | null {
  if (!createTimeMs) return null;
  return `${senderId}|${createTimeMs}|${text.slice(0, 200)}`;
}

/** Returns true if already seen, false if new (and records it). */
export function isDuplicate(key: string): boolean {
  const s = load();
  gc(s);
  if (s.some((e) => e.key === key)) return true;
  s.push({ key, ts: Date.now() });
  persist(s);
  return false;
}
