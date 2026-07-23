import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * OMP session wrapper for a single WeChat chat.
 * Creates the session, subscribes to replies, injects prompts.
 */
export interface SessionEntry {
  session: AgentSession;
  lastActive: number;
  contextToken: string;
}

export async function createSession(
  chatId: string,
  contextToken: string,
  config: AppConfig,
  onReply: (chatId: string, text: string) => void,
): Promise<SessionEntry> {
  logger.info(`Creating session: ${chatId}`);

  const { session, modelFallbackMessage } = await createAgentSession({
    sessionManager: SessionManager.inMemory(),
    cwd: config.cwd,
    enableMCP: false,
    enableLsp: false,
    modelPattern: config.model || undefined,
    systemPrompt: config.systemPrompt,
    toolNames: config.tools,
  });

  if (modelFallbackMessage) {
    logger.warn(`Model fallback: ${modelFallbackMessage}`);
  }

  // Subscribe to assistant replies
  session.subscribe((event: AgentSessionEvent) => {
    if (event.type !== "message_end") return;
    if (event.message.role !== "assistant") return;

    const text = extractAssistantText(event.message);
    if (text) {
      onReply(chatId, text);
    }
  });

  return {
    session,
    lastActive: Date.now(),
    contextToken,
  };
}

/** Extract plain text from an assistant message */
function extractAssistantText(message: { content: unknown }): string {
  const content = message.content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      parts.push(block.text);
    }
  }
  return parts.join("\n").trim();
}
