import { loadConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { chunkText } from "./utils/chunk.js";
import { login } from "./ilink/login.js";
import { installService, uninstallService, serviceStatus } from "./daemon.js";
import {
  getCredentials,
  getUpdates,
  sendMessage,
  sendTyping,
  loadSyncBuf,
  saveSyncBuf,
  extractInboundText,
} from "./ilink/client.js";
import type { InboundMessage, Credentials } from "./ilink/types.js";
import {
  gate,
  approvePairing,
  addToAllowlist,
  revokeFromAllowlist,
  listAllowed,
} from "./access/control.js";
import {
  setReplyHandler,
  setMaxSessions,
  promptSession,
  getPoolStatus,
  getContextToken,
  disposeAll,
} from "./engine/pool.js";

const MAX_FAILURES = 3;
const BACKOFF_MS = 30_000;
const RETRY_MS = 2_000;
const MAX_SEND_RETRIES = 2;
const CHUNK_LIMIT = 2000;

// --- CLI entry point ---

const command = process.argv[2] ?? "run";

switch (command) {
  case "login":
    await login();
    break;
  case "run":
    await run();
    break;
  case "install":
    installService();
    break;
  case "uninstall":
    uninstallService();
    break;
  case "pair": {
    const code = process.argv[3];
    if (!code) {
      console.error("Usage: omp-wechat pair <code>");
      process.exit(1);
    }
    const ok = approvePairing(code);
    if (ok) {
      console.log(`Pairing code ${code} approved`);
    } else {
      console.error(`Pairing code ${code} not found or expired`);
      process.exit(1);
    }
    break;
  }
  case "allow": {
    const wxid = process.argv[3];
    if (!wxid) {
      console.error("Usage: omp-wechat allow <wxid>");
      process.exit(1);
    }
    addToAllowlist(wxid);
    console.log(`Authorized: ${wxid}`);
    break;
  }
  case "revoke": {
    const wxid = process.argv[3];
    if (!wxid) {
      console.error("Usage: omp-wechat revoke <wxid>");
      process.exit(1);
    }
    const ok = revokeFromAllowlist(wxid);
    if (ok) {
      console.log(`Revoked: ${wxid}`);
    } else {
      console.error(`Not found: ${wxid}`);
      process.exit(1);
    }
    break;
  }
  case "list": {
    const allowed = listAllowed();
    if (allowed.length === 0) {
      console.log("(no authorized users)");
    } else {
      console.log("Authorized users:");
      for (const wxid of allowed) {
        console.log(`  ${wxid}`);
      }
    }
    break;
  }
  case "status": {
    serviceStatus();
    const pool = getPoolStatus();
    const allowed = listAllowed();
    console.log(`Session pool: ${pool.count}/${pool.max}`);
    console.log(`Authorized users: ${allowed.length}`);
    if (pool.chats.length > 0) {
      console.log("Active chats:");
      for (const chat of pool.chats) {
        const ago = Math.round((Date.now() - chat.lastActive) / 1000);
        console.log(`  ${chat.chatId} (${ago}s ago)`);
      }
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Available commands: login, run, install, uninstall, pair, allow, revoke, list, status");
    process.exit(1);
}

// --- Main run loop ---

async function run(): Promise<void> {
  const config = loadConfig();
  setMaxSessions(config.maxSessions);

  const creds = getCredentials();

  logger.info("OMP-Wechat starting", {
    cwd: config.cwd,
    model: config.model || "(OMP default)",
    tools: config.tools,
    maxSessions: config.maxSessions,
    dmPolicy: config.dmPolicy,
  });

  // Reply handler: OMP reply -> send to WeChat
  setReplyHandler((chatId: string, text: string) => {
    // Cancel typing indicator before sending the reply
    sendTyping(creds, chatId, 2).catch(() => {});
    sendReply(creds, chatId, text).catch((err: unknown) => {
      logger.error(`[${chatId}] Reply send failed:`, err);
    });
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    logger.info("Shutting down...");
    await disposeAll();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await disposeAll();
    process.exit(0);
  });

  // Start long-poll
  await pollLoop(creds);
}

async function pollLoop(creds: Credentials): Promise<void> {
  let buf = loadSyncBuf();
  let failures = 0;

  logger.info("Long-poll started");

  while (true) {
    try {
      const resp = await getUpdates(creds, buf);

      if (resp.ret !== undefined && resp.ret !== 0) {
        failures++;
        logger.warn(
          `getupdates error ret=${resp.ret} errmsg=${resp.errmsg ?? ""} (${failures}/${MAX_FAILURES})`,
        );
        if (failures >= MAX_FAILURES) {
          failures = 0;
          await Bun.sleep(BACKOFF_MS);
        } else {
          await Bun.sleep(RETRY_MS);
        }
        continue;
      }

      failures = 0;

      if (resp.get_updates_buf) {
        buf = resp.get_updates_buf;
        saveSyncBuf(buf);
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        await handleInbound(creds, msg).catch((err: unknown) => {
          logger.error("Message handler error:", err);
        });
      }
    } catch (err: unknown) {
      failures++;
      logger.error(`Poll error (${failures}/${MAX_FAILURES}):`, err);
      if (failures >= MAX_FAILURES) {
        failures = 0;
        await Bun.sleep(BACKOFF_MS);
      } else {
        await Bun.sleep(RETRY_MS);
      }
    }
  }
}

async function handleInbound(
  creds: Credentials,
  msg: InboundMessage,
): Promise<void> {
  // Only handle user messages (type 1)
  if (msg.message_type !== 1) return;

  const senderId = msg.from_user_id;
  if (!senderId) return;

  const contextToken = msg.context_token ?? "";
  const result = gate(senderId);

  if (result.action === "drop") return;

  if (result.action === "pair") {
    if (contextToken) {
      const lead = result.isResend ? "Still waiting for pairing" : "Pairing required";
      const text = `${lead} — run in terminal:\n\nomp-wechat pair ${result.code}`;
      await sendMessage(creds, senderId, text, contextToken).catch((err: unknown) => {
        logger.warn("Pairing reply send failed:", err);
      });
    }
    return;
  }

  // Message passed the gate, inject into OMP
  const text = extractInboundText(msg);
  if (!text) return;

  const config = loadConfig();
  logger.info(`[${senderId}] Inbound: ${text.slice(0, 80)}`);

  // Show typing indicator while the model is thinking
  await sendTyping(creds, senderId, 1).catch(() => {});

  try {
    await promptSession(senderId, contextToken, text, config);
  } catch (err: unknown) {
    logger.error(`[${senderId}] prompt failed:`, err);
    await sendReply(creds, senderId, "Processing failed, please try again.");
  }
}

async function sendReply(
  creds: Credentials,
  chatId: string,
  text: string,
): Promise<void> {
  const contextToken = getContextToken(chatId);
  if (!contextToken) {
    logger.warn(`[${chatId}] No context_token, cannot reply`);
    return;
  }

  // Chunk long text
  const chunks = chunkText(text, CHUNK_LIMIT);

  for (const chunk of chunks) {
    let retries = 0;
    while (retries <= MAX_SEND_RETRIES) {
      try {
        await sendMessage(creds, chatId, chunk, contextToken);
        break;
      } catch (err: unknown) {
        retries++;
        if (retries > MAX_SEND_RETRIES) {
          logger.error(`[${chatId}] Send failed, dropping:`, err);
          return;
        }
        logger.warn(`[${chatId}] Send retry ${retries}/${MAX_SEND_RETRIES}:`, err);
        await Bun.sleep(1000 * retries);
      }
    }
  }
}
