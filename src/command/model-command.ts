/**
 * /model and /models — query and switch the AI model from WeChat.
 *
 * Usage:
 *   /model                Show current model
 *   /models               List all available models
 *   /model provider/id    Switch to a specific model (e.g. anthropic/claude-haiku-4-5)
 *
 * Role aliases (@smol, @slow) are resolved only at session creation
 * (via config.yml → createAgentSession modelPattern). Runtime switching
 * requires a concrete provider/id — use /models to discover them.
 */
import type { ChatCommand, ChatCommandInvocation, ChatCommandContext } from "./registry.js";
import {
  currentModel,
  listModels,
  switchModel,
} from "../engine/model-controller.js";

const MODEL_PREFIX = "/model";
const MODELS_PREFIX = "/models";

class ModelQueryInvocation implements ChatCommandInvocation {
  async execute(ctx: ChatCommandContext): Promise<string> {
    const entry = ctx.pool.get(ctx.chatId);
    if (!entry) return "No active session for this chat.";

    const info = currentModel(entry.session);
    if (!info) return "No model selected.";

    return `Current model: ${info.provider}/${info.id} (${info.name})`;
  }
}

class ModelListInvocation implements ChatCommandInvocation {
  async execute(ctx: ChatCommandContext): Promise<string> {
    const entry = ctx.pool.get(ctx.chatId);
    if (!entry) return "No active session for this chat.";

    const models = listModels(entry.session);
    if (models.length === 0) return "No models available.";

    const cur = currentModel(entry.session);
    const curKey = cur ? `${cur.provider}/${cur.id}` : "";

    const lines: string[] = [`Available models (${models.length}):`];
    for (const m of models) {
      const key = `${m.provider}/${m.id}`;
      const marker = key === curKey ? " ← current" : "";
      lines.push(`  ${key} (${m.name})${marker}`);
    }
    lines.push("", "Switch with: /model provider/id");
    return lines.join("\n");
  }
}

class ModelSwitchInvocation implements ChatCommandInvocation {
  constructor(private readonly pattern: string) {}

  async execute(ctx: ChatCommandContext): Promise<string> {
    const entry = ctx.pool.get(ctx.chatId);
    if (!entry) return "No active session for this chat.";

    const result = await switchModel(this.pattern, entry.session);
    return result.message;
  }
}

export class ModelCommand implements ChatCommand {
  name = "model";

  parse(text: string): ChatCommandInvocation | null {
    // /models (plural) — list
    if (text === MODELS_PREFIX || text.startsWith(`${MODELS_PREFIX} `)) {
      return new ModelListInvocation();
    }

    // /model (no args) — show current
    if (text === MODEL_PREFIX) {
      return new ModelQueryInvocation();
    }

    // /model provider/id — switch
    if (text.startsWith(`${MODEL_PREFIX} `)) {
      const pattern = text.slice(MODEL_PREFIX.length + 1).trim();
      if (pattern) return new ModelSwitchInvocation(pattern);
    }

    return null;
  }
}
