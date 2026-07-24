/**
 * WeChatBridge — orchestrates the iLink long-poll loop, message handling,
 * command dispatch, and reply delivery.
 *
 * This class is the composition root: it wires together the iLink client
 * (transport), SessionPool (AI engine), CommandRegistry (chat commands),
 * and access control. It replaces the former module-level function soup
 * where `pollActive`, `lockServer`, and `replyHandler` were scattered
 * across module scope.
 *
 * Lifecycle:
 *   const bridge = new WeChatBridge();
 *   bridge.start();   // from extension session_start
 *   bridge.stop();    // from extension shutdown or /wechat stop
 */
import { randomBytes } from "crypto";
import { loadConfig } from "./config.js";
import type { AppConfig } from "./config.js";
import { chunkText } from "./utils/chunk.js";
import { makeDedupKey, isDuplicate } from "./utils/dedup.js";
import { logger } from "./utils/logger.js";
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
import { SessionPool } from "./engine/pool.js";
import { CommandRegistry } from "./command/registry.js";
import { ModelCommand } from "./command/model-command.js";

const MAX_FAILURES = 3;
const BACKOFF_MS = 30_000;
const RETRY_MS = 2_000;
const MAX_SEND_RETRIES = 2;
const CHUNK_LIMIT = 2000;
const LOCK_PORT = 19821;

import { cleanupStaleSessions } from "./engine/session-store.js";

export interface DaemonState {
  running: boolean;
  config: AppConfig;
  creds: Credentials;
  lastError: string | null;
}

export class WeChatBridge {
  private state: DaemonState | null = null;
  private pollActive = false;
  private lockServer: { stop: (closeActive?: boolean) => void } | null = null;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private pool: SessionPool | null = null;
  private commands = new CommandRegistry();

  constructor() {
    this.commands.register(new ModelCommand());
  }

  /** Start the poll loop. Idempotent — returns existing state if running. */
  start(): DaemonState {
    const config = loadConfig();
    const creds = getCredentials();

    if (this.pollActive) {
      return this.state!;
    }

    if (!this.acquireLock()) {
      logger.debug("Another poll loop is running (port lock held), skipping");
      return { running: false, config, creds, lastError: "another instance running" };
    }

    this.pollActive = true;

    // Reply handler: AI reply → send to WeChat
    const replyHandler = (chatId: string, text: string) => {
      sendTyping(creds, chatId, 2).catch(() => {});
      this.sendReply(creds, chatId, text).catch((err: unknown) => {
        logger.error(`[${chatId}] Reply send failed:`, err);
      });
    };

    this.pool = new SessionPool(config.maxSessions, replyHandler);
    this.state = { running: true, config, creds, lastError: null };

    logger.info("OMP-Wechat poll loop starting", {
      maxSessions: config.maxSessions,
      dmPolicy: config.dmPolicy,
      model: config.model ?? "(omp default)",
    });

    this.pollLoop(creds, this.state).catch((err: unknown) => {
      logger.error("Poll loop crashed:", err);
      this.state!.running = false;
      this.state!.lastError = String(err);
      this.pollActive = false;
      this.releaseLock();
    });

    // Cleanup stale session directories. Run immediately on start so
    // it always fires even if OMP kills this process within seconds
    // (observed ~10s restart cycle). The periodic timer handles the
    // long-lived case (boot-service process that survives for hours).
    cleanupStaleSessions();
    this.cleanupTimer = setInterval(() => cleanupStaleSessions(), 6 * 60 * 60 * 1000);

    return this.state;
  }

  /** Stop the poll loop and dispose all sessions. */
  async stop(): Promise<void> {
    this.pollActive = false;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.releaseLock();
    if (this.pool) {
      await this.pool.disposeAll();
    }
    logger.info("Poll loop stopped");
  }

  getPoolStatus() {
    return this.pool?.getPoolStatus() ?? { count: 0, max: 0, chats: [] };
  }

  private acquireLock(): boolean {
    try {
      this.lockServer = Bun.serve({
        port: LOCK_PORT,
        hostname: "127.0.0.1",
        fetch() {
          return new Response("ok");
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    if (this.lockServer) {
      this.lockServer.stop(true);
      this.lockServer = null;
    }
  }

  private async pollLoop(creds: Credentials, state: DaemonState): Promise<void> {
    let failures = 0;
    logger.info("Long-poll started");

    while (this.pollActive) {
      try {
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
          await this.handleInbound(creds, msg).catch((err: unknown) => {
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

  private async handleInbound(creds: Credentials, msg: InboundMessage): Promise<void> {
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

    // Cross-process dedup: skip iLink re-delivery of the same message.
    const dedupKey = makeDedupKey(senderId, msg.create_time_ms, text);
    if (dedupKey && isDuplicate(dedupKey)) {
      logger.info(`[${senderId}] Skipping duplicate message: ${text.slice(0, 80)}`);
      return;
    }

    const config = loadConfig();
    logger.info(`[${senderId}] Inbound (ts=${msg.create_time_ms ?? "n/a"}): ${text.slice(0, 80)}`);

    // Command dispatch: /model, /models, etc.
    const invocation = this.commands.tryParse(text);
    if (invocation) {
      const reply = await invocation
        .execute({ pool: this.pool!, config, chatId: senderId })
        .catch((err: unknown) => `Command failed: ${err instanceof Error ? err.message : String(err)}`);
      await sendMessage(creds, senderId, reply, contextToken).catch((err: unknown) => {
        logger.warn(`[${senderId}] Command reply send failed:`, err);
      });
      return;
    }

    // Normal message → AI processing
    await sendTyping(creds, senderId, 1).catch(() => {});

    try {
      await this.pool!.prompt(senderId, contextToken, text, config);
    } catch (err: unknown) {
      logger.error(`[${senderId}] prompt failed:`, err);
      await this.sendReply(creds, senderId, "Processing failed, please try again.");
    }
  }

  private async sendReply(creds: Credentials, chatId: string, text: string): Promise<void> {
    const contextToken = this.pool?.getContextToken(chatId) ?? "";
    if (!contextToken) {
      logger.warn(`[${chatId}] No context_token, cannot reply`);
      return;
    }

    const chunks = chunkText(text, CHUNK_LIMIT);

    for (const chunk of chunks) {
      // One client_id per chunk, reused across retries — lets the server
      // de-duplicate if a timeout fires after the message was accepted.
      const clientId = `omp-wechat-${Date.now()}-${randomBytes(4).toString("hex")}`;
      let retries = 0;
      while (retries <= MAX_SEND_RETRIES) {
        try {
          await sendMessage(creds, chatId, chunk, contextToken, clientId);
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
}

// Re-export access control functions for slash commands (index.ts imports these)
export { approvePairing, addToAllowlist, revokeFromAllowlist, listAllowed };
export { clearAllSessions, cleanupStaleSessions } from "./engine/session-store.js";
