import { homedir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";
import { RotatingLog } from "./rotating-log.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.OMP_WECHAT_LOG as LogLevel) ?? "info";

const LOG_DIR = join(homedir(), ".omp", "logs");
const LOG_FILE = join(LOG_DIR, "wechat.log");

// Ensure log dir exists (best-effort, won't throw in import-time)
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

const rotatingLog = new RotatingLog({
  filePath: LOG_FILE,
  maxBytes: 5 * 1024 * 1024,  // 5 MB
  maxFiles: 3,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,  // 30 days
});

// Clean stale log files on startup
rotatingLog.cleanStale();

function ts(): string {
  // 本地时区的 ISO 8601 格式（含时区偏移），跟随系统时区，不写死 +08:00
  const d = new Date();
  const off = -d.getTimezoneOffset(); // 分钟；UTC+8 → 480
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const tz = `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
  // toISOString() 返回 UTC，减去偏移得到本地时间的 ISO 表示，再带上本地时区
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace("Z", tz);
}

function log(level: LogLevel, msg: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const prefix = `[${ts()}] [${level.toUpperCase()}]`;
  const line = meta !== undefined
    ? `${prefix} ${msg} ${JSON.stringify(meta)}\n`
    : `${prefix} ${msg}\n`;
  // File only — writing to stderr pollutes the OMP host process's
  // log output. The wechat.log file is the canonical log source.
  rotatingLog.write(line);
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log("debug", msg, meta),
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
