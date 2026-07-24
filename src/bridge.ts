/**
 * WeChat bridge — poll loop, message handling, and reply logic.
 *
 * These functions are imported by the OMP extension (src/index.ts) and
 * run **in-process** inside the OMP session. The poll loop is driven by
 * `ctx.setInterval` so it is cleaned up automatically on session shutdown.
 */
import { loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { logger } from "./utils/logger.js";
import { chunkText } from "./utils/chunk.js";
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
const POLL_INTERVAL_MS = 0; // long-poll blocks 35s server-side, no extra delay

const LOCK_PORT = 19821; // arbitrary fixed port for singleton enforcement

export interface DaemonState {
  running: boolean;
  config: AppConfig;
  creds: Credentials;
  lastError: string | null;
}

let pollActive = false;
let lockServer: { stop: (closeActive?: boolean) => void } | null = null;

/**
 * Acquire singleton lock by binding a TCP port. OS guarantees only one
 * process can hold the port. Process exit auto-releases it — no stale
 * locks, no pidfile races, no cleanup needed.
 */
function acquireLock(): boolean {
  try {
    lockServer = Bun.serve({
      port: LOCK_PORT,
      hostname: "127.0.0.1",
      fetch() {
        return new Response("ok");
      },
    });
    return true;
  } catch {
    // Port already in use — another process holds the lock
    return false;
  }
}

function releaseLock(): void {
  if (lockServer) {
    lockServer.stop(true);
    lockServer = null;
  }
}

/**
 * Start the iLink long-poll loop in-process. Called from the extension's
 * `session_start` handler. Safe to call multiple times — does nothing if
 * already running.
 */
export function startPollLoop(): DaemonState {
  const config = loadConfig();
  const creds = getCredentials();

  // Guard against concurrent session_start events in the same process
  if (pollActive) {
    return { running: true, config, creds, lastError: null };
  }

  // Singleton: only one process can bind the lock port
  if (!acquireLock()) {
    logger.debug("Another poll loop is running (port lock held), skipping");
    return { running: false, config, creds, lastError: "another instance running" };
  }

  pollActive = true;
  setMaxSessions(config.maxSessions);

  const state: DaemonState = { running: true, config, creds, lastError: null };

  // Reply handler: OMP reply -> send to WeChat
  setReplyHandler((chatId: string, text: string) => {
    sendTyping(creds, chatId, 2).catch(() => {});
    sendReply(creds, chatId, text).catch((err: unknown) => {
      logger.error(`[${chatId}] Reply send failed:`, err);
    });
  });

  logger.info("OMP-Wechat poll loop starting", {
    maxSessions: config.maxSessions,
    dmPolicy: config.dmPolicy,
  });

  // Fire and forget — the loop runs as a background promise
  pollLoop(creds, state).catch((err: unknown) => {
    logger.error("Poll loop crashed:", err);
    state.running = false;
    state.lastError = String(err);
    pollActive = false;
    releaseLock();
  });

  return state;
}

/** Stop the poll loop and dispose all sessions. */
export async function stopPollLoop(): Promise<void> {
  pollActive = false;
  releaseLock();
  await disposeAll();
  logger.info("Poll loop stopped");
}

async function pollLoop(
  creds: Credentials,
  state: DaemonState,
): Promise<void> {
  let failures = 0;

  logger.info("Long-poll started");

  while (pollActive) {
    try {
      // Re-read sync_buf from disk each iteration — another poll loop
      // instance (from a prior session that didn't shut down cleanly)
      // may have advanced it.
      const buf = loadSyncBuf();
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
      state.lastError = null;

      if (resp.get_updates_buf && resp.get_updates_buf !== buf) {
        saveSyncBuf(resp.get_updates_buf);
      }

      const msgs = resp.msgs ?? [];
      for (const msg of msgs) {
        await handleInbound(creds, msg).catch((err: unknown) => {
          logger.error("Message handler error:", err);
        });
      }
    } catch (err: unknown) {
      failures++;
      state.lastError = String(err);
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
  if (msg.message_type !== 1) return;

  const senderId = msg.from_user_id;
  if (!senderId) return;

  const contextToken = msg.context_token ?? "";
  const result = gate(senderId);

  if (result.action === "drop") return;

  if (result.action === "pair") {
    if (contextToken) {
      const lead = result.isResend ? "Still waiting for pairing" : "Pairing required";
      const text = `${lead} — approve in OMP with: /wechat pair ${result.code}`;
      await sendMessage(creds, senderId, text, contextToken).catch((err: unknown) => {
        logger.warn("Pairing reply send failed:", err);
      });
    }
    return;
  }

  const text = extractInboundText(msg);
  if (!text) return;

  const config = loadConfig();
  logger.info(`[${senderId}] Inbound: ${text.slice(0, 80)}`);

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

// Re-export access control functions for slash commands
export {
  approvePairing,
  addToAllowlist,
  revokeFromAllowlist,
  listAllowed,
  getPoolStatus,
};
