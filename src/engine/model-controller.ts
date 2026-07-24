/**
 * Model management for WeChat chat sessions.
 *
 * Provides runtime model query and switching via the AgentSession's
 * modelRegistry. Role aliases (@smol, @slow, etc.) are NOT resolved
 * here — they are only honored at session creation time via
 * createAgentSession({ modelPattern }), where the OMP SDK resolves
 * them against the user's OMP settings. At runtime, users switch by
 * concrete provider/model-id (listed by /models).
 */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
}

export interface SwitchResult {
  ok: boolean;
  message: string;
}

/** Extract a compact, user-readable model descriptor from a session. */
export function currentModel(session: AgentSession): ModelInfo | undefined {
  const m = session.model;
  if (!m) return undefined;
  return {
    provider: m.provider,
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
  };
}

/** List all available models from the session's model registry. */
export function listModels(session: AgentSession): ModelInfo[] {
  return session.modelRegistry.getAvailable().map((m) => ({
    provider: m.provider,
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow,
  }));
}

/**
 * Resolve a "provider/id" string to a Model via the registry.
 * Returns null if not found or if the input isn't in provider/id form.
 */
export function resolveModel(
  pattern: string,
  session: AgentSession,
): ModelInfo | null {
  const trimmed = pattern.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) return null; // not a provider/id pattern

  const provider = trimmed.slice(0, slash);
  const modelId = trimmed.slice(slash + 1);
  if (!provider || !modelId) return null;

  const model = session.modelRegistry.find(provider, modelId);
  if (!model) return null;

  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
  };
}

/**
 * Temporarily switch the session's model. Does NOT persist to OMP
 * settings — only affects this WeChat chat session.
 */
export async function switchModel(
  pattern: string,
  session: AgentSession,
): Promise<SwitchResult> {
  const info = resolveModel(pattern, session);
  if (!info) {
    return {
      ok: false,
      message: `Unknown model: ${pattern}\nUse /models to see available options (format: provider/model-id).`,
    };
  }

  // Find the actual Model object for setModelTemporary
  const model = session.modelRegistry.find(info.provider, info.id);
  if (!model) {
    return { ok: false, message: `Model not found: ${pattern}` };
  }

  try {
    await session.setModelTemporary(model);
    return {
      ok: true,
      message: `Switched to ${info.provider}/${info.id} (${info.name})`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Switch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

