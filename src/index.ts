/**
 * OMP extension entry point for OMP-Wechat.
 *
 * On `session_start`, attempts to start the iLink long-poll loop
 * in-process via a singleton port lock. If another process already
 * holds the lock, this process skips the poll loop but keeps a
 * 30s failover timer — if the lock holder dies, this process
 * takes over automatically.
 *
 * Slash commands:
 *   /wechat login    — scan QR code to log in
 *   /wechat status   — show poll loop + session pool + authorized users
 *   /wechat pair <code>   — approve a pairing request
 *   /wechat allow <wxid>  — directly authorize a user
 *   /wechat revoke <wxid> — revoke a user's authorization
 *   /wechat list     — list authorized users
 *   /wechat stop     — stop the poll loop
 *   /wechat install  — install boot-time launchd/systemd service
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


// ═══════════════════════════════════════════════════════════════════════════
let bridge: WeChatBridge | null = null;
let daemonState: DaemonState | null = null;

// ═══════════════════════════════════════════════════════════════════════════
// Extension factory
// ═══════════════════════════════════════════════════════════════════════════

export default function wechatExtension(pi: ExtensionAPI) {
  if (pi.pi && typeof pi.setLabel === "function") {
    pi.setLabel("OMP-Wechat Bridge");
  }

  pi.on("session_start", async (_event, ctx) => {
    // Try to start the poll loop. If another process holds the lock,
    // start() returns { running: false } — we set up a failover
    // timer to periodically retry in case the lock holder dies.
    bridge = new WeChatBridge();
    daemonState = bridge.start();

    if (daemonState.running) {
      ctx.ui.notify("WeChat bridge started", "info");
    } else {
      // Not the lock holder — start a failover check every 30s.
      // If the lock holder crashes, this process will take over.
      logger.debug("WeChat bridge: another instance holds the lock, starting failover watch");
      ctx.setInterval(() => {
        if (daemonState?.running) return; // already running
        daemonState = bridge!.start();
        if (daemonState.running) {
          ctx.ui.notify("WeChat bridge: took over from failed instance", "info");
        }
      }, 30_000);
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
                `OMP will run via launchd/systemd at boot. ` +
                `Manage: ${r.platform === "darwin" ? "launchctl start|stop com.omp-wechat" : "sudo systemctl start|stop omp-wechat"}`,
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
