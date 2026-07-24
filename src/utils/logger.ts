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
  return new Date().toISOString();
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
