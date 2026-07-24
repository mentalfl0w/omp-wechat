import { homedir } from "os";
import { join } from "path";
import { mkdirSync, appendFileSync } from "fs";

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

function ts(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, msg: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const prefix = `[${ts()}] [${level.toUpperCase()}]`;
  const line = meta !== undefined
    ? `${prefix} ${msg} ${JSON.stringify(meta)}\n`
    : `${prefix} ${msg}\n`;
  // stderr (visible when run in foreground) + file (visible when detached)
  process.stderr.write(line);
  try {
    appendFileSync(LOG_FILE, line);
  } catch {}
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log("debug", msg, meta),
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
