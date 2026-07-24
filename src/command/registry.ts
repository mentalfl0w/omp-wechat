/**
 * Chat command framework — extensible handler for /model, /models, etc.
 *
 * When an inbound WeChat message starts with "/", the bridge tries to
 * parse it as a chat command. If matched, the command executes directly
 * (model switch, status, etc.) instead of being sent to the AI. This
 * lets users control the bridge from WeChat without touching the terminal.
 */
import type { SessionPool } from "../engine/pool.js";
import type { AppConfig } from "../config.js";

export interface ChatCommandContext {
  pool: SessionPool;
  config: AppConfig;
  chatId: string;
}

export interface ChatCommand {
  /** Command name, e.g. "model" — matched against the first /-word. */
  name: string;
  /**
   * Try to parse the inbound text. Return null if this command doesn't
   * claim it; return an invocation object if it does.
   */
  parse(text: string): ChatCommandInvocation | null;
}

export interface ChatCommandInvocation {
  /** Execute the command, returning a text reply to send back to the user. */
  execute(ctx: ChatCommandContext): Promise<string>;
}

/** Registry of chat commands. Bridge consults this on every inbound. */
export class CommandRegistry {
  private commands: ChatCommand[] = [];

  register(cmd: ChatCommand): void {
    this.commands.push(cmd);
  }

  /**
   * Try to match an inbound message against a registered command.
   * Returns null if the message isn't a command (doesn't start with "/").
   */
  tryParse(text: string): ChatCommandInvocation | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    for (const cmd of this.commands) {
      const inv = cmd.parse(trimmed);
      if (inv) return inv;
    }
    return null;
  }
}
