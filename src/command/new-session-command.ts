/**
 * /new — reset the current WeChat chat session.
 *
 * Disposes the existing AI session and clears its context. The next
 * inbound message creates a fresh session with no prior history.
 */
import type { ChatCommand, ChatCommandInvocation, ChatCommandContext } from "./registry.js";

class NewSessionInvocation implements ChatCommandInvocation {
  async execute(ctx: ChatCommandContext): Promise<string> {
    await ctx.pool.resetSession(ctx.chatId);
    return "Session reset. Your next message starts a fresh conversation.";
  }
}

export class NewSessionCommand implements ChatCommand {
  name = "new";

  parse(text: string): ChatCommandInvocation | null {
    if (text === "/new" || text === "/reset") {
      return new NewSessionInvocation();
    }
    return null;
  }
}
