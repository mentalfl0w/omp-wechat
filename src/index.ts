/**
 * OMP extension entry point for OMP-Wechat.
 *
 * At extension load time, starts the iLink long-poll loop in-process
 * via a singleton port lock. If another process already holds the
 * lock, this process skips the poll loop but keeps a 30s failover
 * timer — if the lock holder dies, this process takes over automatically.
 *
 * The failover timer is unref'd and every resource (timer, in-flight long
 * poll/backoff, port lock, sessions) is torn down on `session_shutdown`, so
 * one-shot host commands such as `omp models --json` can exit normally while
 * the persistent RPC service keeps working.
 *
 * Slash commands:
 *   /wechat login    — scan QR code to log in
 *   /wechat status   — show poll loop + session pool + authorized users
 *   /wechat pair <code>   — approve a pairing request
 *   /wechat allow <wxid>  — directly authorize a user
 *   /wechat revoke <wxid> — revoke a user's authorization
 *   /wechat list     — list authorized users
 *   /wechat stop     — stop the poll loop
 *   /wechat install  — install boot-time launchd/systemd/Task Scheduler service
 *   /wechat uninstall — remove boot-time service
 */
import { login } from "./ilink/login.js";
import { WeChatBridge, clearAllSessions } from "./bridge.js";
import type { DaemonState } from "./bridge.js";
import {
  approvePairing,
  addToAllowlist,
  revokeFromAllowlist,
  listAllowed,
} from "./access/control.js";
import { installService, uninstallService, isServiceInstalled } from "./service.js";
import { logger } from "./utils/logger.js";
import { setUnrefInterval } from "./utils/runtime-compat.js";

// ═══════════════════════════════════════════════════════════════════════════
// Types — matches the ExtensionAPI surface from OMP
// ═══════════════════════════════════════════════════════════════════════════

interface ExtensionContext {
  ui: {
    notify: (msg: string, level: "info" | "warn" | "error") => void;
  };
  cwd: string;
  setInterval(fn: (...args: unknown[]) => void, ms: number, ...args: unknown[]): unknown;
  clearInterval(timer: unknown): void;
}

interface ExtensionCommandContext extends ExtensionContext {
  waitForIdle(): Promise<void>;
}

interface ExtensionAPI {
  pi?: unknown; // OMP injects self-ref; Pi does not — truthy = OMP
  setLabel?: (entryIdOrLabel: string, label?: string) => void;
  on: (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>,
  ) => void;
  registerCommand: (
    name: string,
    def: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
    },
  ) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

let bridge: WeChatBridge | null = null;
let daemonState: DaemonState | null = null;
let retryTimer: Timer | null = null;
/** Set once the host has begun shutting the extension down; blocks retry takeover. */
let shuttingDown = false;

/**
 * Host `session_shutdown` handlers get a 2s budget. Leave headroom for the
 * host while still letting an in-flight long poll abort and sessions dispose.
 */
const SHUTDOWN_GRACE_MS = 1_500;

function clearRetryTimer(): void {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════

export default async function wechatExtension(pi: ExtensionAPI) {
  if (pi.pi && typeof pi.setLabel === "function") {
    pi.setLabel("OMP-Wechat Bridge");
  }

  // Start the poll loop at extension load time — don't wait for session_start.
  // bridge.start() acquires the port lock + starts the long-poll fetch; a
  // persistent RPC host keeps this process alive independently (heartbeat on
  // stdin), so the extension does not need to.
  bridge = new WeChatBridge();
  daemonState = await bridge.start();

  if (daemonState.running) {
    logger.info("WeChat bridge started at extension load");
  } else {
    // Not running (not logged in, or another instance holds the lock).
    // Retry every 30s — picks up after /wechat login or takes over if the
    // lock holder crashes. Unref'd: standby must not keep a short-lived
    // command such as `omp models --json` alive after its work is done.
    logger.debug("WeChat bridge not running, starting 30s retry", { lastError: daemonState.lastError });
    retryTimer = setUnrefInterval(() => {
      void (async () => {
        const active = bridge;
        if (shuttingDown || !active || daemonState?.running) return;
        try {
          daemonState = await active.start();
        } catch (err) {
          logger.error("WeChat bridge restart failed:", err);
          return;
        }
        if (daemonState.running) {
          clearRetryTimer();
          logger.info("WeChat bridge: took over from failed instance");
        }
      })();
    }, 30_000);
  }

  pi.on("session_start", async (_event, ctx) => {
    // Poll loop is already running from extension load.
    // If it was stopped (e.g. via /wechat stop), try to restart.
    if (shuttingDown) return;
    if (bridge && !daemonState?.running) {
      try {
        daemonState = await bridge.start();
      } catch (err) {
        logger.error("WeChat bridge start failed:", err);
        return;
      }
      if (daemonState.running) {
        clearRetryTimer();
        ctx.ui.notify("WeChat bridge started", "info");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    // Short-lived commands (`omp models --json`, print mode) emit this after
    // their work completes. Release everything the extension owns so the host
    // event loop can drain; the persistent RPC service keeps its host alive
    // via stdin heartbeat and is unaffected until it too shuts down.
    shuttingDown = true;
    clearRetryTimer();
    const active = bridge;
    bridge = null;
    daemonState = null;
    if (!active) return;
    try {
      await active.stop(SHUTDOWN_GRACE_MS);
    } catch (err) {
      logger.error("WeChat bridge shutdown failed:", err);
    }
  });

  pi.registerCommand("wechat", {
    description:
      "WeChat bridge: login, status, pair, allow, revoke, list, stop, clear, install, uninstall",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] ?? "";
      const arg1 = parts[1] ?? "";

      switch (sub) {
        case "":
        case "status": {
          const running = daemonState?.running ?? false;
          const svc = isServiceInstalled();
          const pool = bridge?.getPoolStatus() ?? { count: 0, max: 0, chats: [] };
          const allowed = listAllowed();
          const lines = [
            `Poll loop: ${running ? "running" : "stopped"}`,
            `Boot service: ${svc ? "installed" : "not installed"}`,
            `Last error: ${daemonState?.lastError ?? "none"}`,
            `Session pool: ${pool.count}/${pool.max}`,
            `Authorized users: ${allowed.length}`,
          ];
          if (pool.chats.length > 0) {
            lines.push("Active chats:");
            for (const chat of pool.chats) {
              const ago = Math.round((Date.now() - chat.lastActive) / 1000);
              lines.push(`  ${chat.chatId} (${ago}s ago)`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "login": {
          ctx.ui.notify("Starting WeChat QR login...", "info");
          try {
            await login();
            ctx.ui.notify("WeChat login successful", "info");
          } catch (err) {
            ctx.ui.notify(`Login failed: ${err}`, "error");
          }
          break;
        }

        case "pair": {
          if (!arg1) {
            ctx.ui.notify("Usage: /wechat pair <code>", "warn");
            return;
          }
          const ok = approvePairing(arg1);
          ctx.ui.notify(ok ? `Pairing ${arg1} approved` : `Code ${arg1} not found`, ok ? "info" : "error");
          break;
        }

        case "allow": {
          if (!arg1) {
            ctx.ui.notify("Usage: /wechat allow <wxid>", "warn");
            return;
          }
          addToAllowlist(arg1);
          ctx.ui.notify(`Authorized: ${arg1}`, "info");
          break;
        }

        case "revoke": {
          if (!arg1) {
            ctx.ui.notify("Usage: /wechat revoke <wxid>", "warn");
            return;
          }
          const ok = revokeFromAllowlist(arg1);
          ctx.ui.notify(ok ? `Revoked: ${arg1}` : `Not found: ${arg1}`, ok ? "info" : "error");
          break;
        }

        case "list": {
          const allowed = listAllowed();
          ctx.ui.notify(
            allowed.length === 0 ? "(no authorized users)" : `Authorized: ${allowed.join(", ")}`,
            "info",
          );
          break;
        }

        case "stop": {
          clearRetryTimer();
          if (bridge) {
            await bridge.stop();
            bridge = null;
          }
          daemonState = null;
          ctx.ui.notify("WeChat bridge stopped", "info");
          break;
        }

        case "install": {
          try {
            const r = installService();
            ctx.ui.notify(`Boot service installed (${r.platform}): ${r.path}`, "info");
            logger.info(
              `Service installed on ${r.platform} at ${r.path}\n` +
                `OMP will run via ${r.platform === "darwin" ? "launchd" : r.platform === "win32" ? "Task Scheduler" : "systemd"} at boot. ` +
                `Manage: ${r.platform === "darwin" ? "launchctl start|stop com.omp-wechat" : r.platform === "win32" ? "schtasks /run|/end /tn OMP-Wechat" : "sudo systemctl start|stop omp-wechat"}`,
            );
          } catch (err) {
            ctx.ui.notify(`Install failed: ${err}`, "error");
          }
          break;
        }

        case "uninstall": {
          try {
            const r = uninstallService();
            ctx.ui.notify(`Boot service uninstalled: ${r.path}`, "info");
          } catch (err) {
            ctx.ui.notify(`Uninstall failed: ${err}`, "error");
          }
          break;
        }

        case "clear": {
          clearRetryTimer();
          if (bridge) {
            await bridge.stop();
            bridge = null;
          }
          daemonState = null;
          const removed = clearAllSessions();
          ctx.ui.notify(`Cleared ${removed} session(s)`, "info");
          break;
        }

        default:
          ctx.ui.notify(
            "Unknown subcommand. Available: login, status, pair, allow, revoke, list, stop, clear, install, uninstall",
            "warn",
          );
      }
    },
  });
}
