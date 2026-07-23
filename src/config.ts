import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { logger } from "./utils/logger.js";

export interface AppConfig {
  /** OMP working directory */
  cwd: string;
  /** Model spec (provider/model format), empty = OMP default */
  model: string;
  /** Allowed tool list */
  tools: string[];
  /** Session pool cap */
  maxSessions: number;
  /** Access policy */
  dmPolicy: string;
  /** System prompt */
  systemPrompt: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant chatting with users via WeChat.

Constraints:
- Reply in plain text; WeChat does not render Markdown
- Keep replies concise; WeChat has a ~2000 character limit per message
- If you need to write code or long documents, summarize the key points; the user will review on their computer
- Users may send short or incomplete messages from their phone; proactively understand their intent`;

const CONFIG_DIR = join(homedir(), ".omp-wechat");
const CONFIG_FILE = join(CONFIG_DIR, "config.yml");

/** Load config: env vars take priority, then config.yml, then defaults */
export function loadConfig(): AppConfig {
  const env = process.env;

  // Try loading .env file
  loadEnvFile();

  const config: AppConfig = {
    cwd: env.OMP_WECHAT_CWD || process.cwd(),
    model: env.OMP_MODEL || "",
    tools: (env.OMP_WECHAT_TOOLS || "read,grep,glob,write,edit,bash")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    maxSessions: parseInt(env.OMP_WECHAT_MAX_SESSIONS || "50", 10),
    dmPolicy: env.OMP_WECHAT_DM_POLICY || "pairing",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };

  // Try loading config.yml (env vars take priority)
  try {
    if (existsSync(CONFIG_FILE)) {
      const yaml = readFileSync(CONFIG_FILE, "utf8");
      const parsed = parseSimpleYaml(yaml);

      if (parsed.cwd && !env.OMP_WECHAT_CWD) config.cwd = parsed.cwd;
      if (parsed.model && !env.OMP_MODEL) config.model = parsed.model;
      if (parsed.maxSessions && !env.OMP_WECHAT_MAX_SESSIONS)
        config.maxSessions = parseInt(parsed.maxSessions, 10);
      if (parsed.dmPolicy && !env.OMP_WECHAT_DM_POLICY)
        config.dmPolicy = parsed.dmPolicy;
      if (parsed.tools && !env.OMP_WECHAT_TOOLS)
        config.tools = parsed.tools.split(",").map((s) => s.trim()).filter(Boolean);
      if (parsed.systemPrompt) config.systemPrompt = parsed.systemPrompt;
    }
  } catch (err) {
    logger.warn("Failed to load config.yml, using env/defaults", err);
  }

  return config;
}

/** Simple .env file loader */
function loadEnvFile(): void {
  const envPath = join(CONFIG_DIR, ".env");
  if (!existsSync(envPath)) return;

  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore
  }
}

/** Minimal YAML parser (supports key: value format only) */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inMultiline = false;
  let multilineKey = "";
  let multilineBuf: string[] = [];

  for (const line of yaml.split("\n")) {
    // Multiline string (systemPrompt: |)
    if (inMultiline) {
      if (line.startsWith("  ") || line === "") {
        multilineBuf.push(line.replace(/^  /, ""));
        continue;
      } else {
        result[multilineKey] = multilineBuf.join("\n").trim();
        inMultiline = false;
        multilineBuf = [];
      }
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (value === "|") {
      inMultiline = true;
      multilineKey = key;
      continue;
    }

    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && value) result[key] = value;
  }

  // Flush trailing multiline
  if (inMultiline && multilineKey) {
    result[multilineKey] = multilineBuf.join("\n").trim();
  }

  return result;
}
