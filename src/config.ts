import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { logger } from "./utils/logger.js";

export interface AppConfig {
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

/** Load config from ~/.omp-wechat/config.yml, falling back to defaults. */
export function loadConfig(): AppConfig {
  const config: AppConfig = {
    maxSessions: 50,
    dmPolicy: "pairing",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  };

  try {
    if (existsSync(CONFIG_FILE)) {
      const yaml = readFileSync(CONFIG_FILE, "utf8");
      const parsed = parseSimpleYaml(yaml);

      if (parsed.maxSessions) config.maxSessions = parseInt(parsed.maxSessions, 10);
      if (parsed.dmPolicy) config.dmPolicy = parsed.dmPolicy;
      if (parsed.systemPrompt) config.systemPrompt = parsed.systemPrompt;
    }
  } catch (err) {
    logger.warn("Failed to load config.yml, using defaults", err);
  }

  return config;
}

/** Minimal YAML parser (supports key: value and multiline `|` blocks) */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  let inMultiline = false;
  let multilineKey = "";
  let multilineBuf: string[] = [];

  for (const line of yaml.split("\n")) {
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

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && value) result[key] = value;
  }

  if (inMultiline && multilineKey) {
    result[multilineKey] = multilineBuf.join("\n").trim();
  }

  return result;
}
