type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.OMP_WECHAT_LOG as LogLevel) ?? "info";

function ts(): string {
  return new Date().toISOString();
}

function log(level: LogLevel, msg: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const prefix = `[${ts()}] [${level.toUpperCase()}]`;
  if (meta !== undefined) {
    process.stderr.write(`${prefix} ${msg} ${JSON.stringify(meta)}\n`);
  } else {
    process.stderr.write(`${prefix} ${msg}\n`);
  }
}

export const logger = {
  debug: (msg: string, meta?: unknown) => log("debug", msg, meta),
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
