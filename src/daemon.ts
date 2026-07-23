import { platform, homedir } from "os";
import { join, dirname } from "path";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "fs";
import { logger } from "./utils/logger.js";

type Platform = "darwin" | "linux" | "win32" | "other";

function detectPlatform(): Platform {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "win32";
  return "other";
}

/** Get the current binary path */
function getBinaryPath(): string {
  return process.execPath;
}

/** Get the project directory (parent of the binary) */
function getProjectDir(): string {
  return dirname(getBinaryPath());
}

/** Get the log directory */
function getLogDir(): string {
  return join(getProjectDir(), "logs");
}

// --- macOS launchd ---

const PLIST_LABEL = "com.omp-wechat";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

function generatePlist(): string {
  const binary = getBinaryPath();
  const projectDir = getProjectDir();
  const logDir = getLogDir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${binary}</string>
    <string>run</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${projectDir}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${logDir}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/stderr.log</string>
</dict>
</plist>
`;
}

function installLaunchd(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });

  // Unload old version if exists
  const path = plistPath();
  if (existsSync(path)) {
    logger.info("Found existing service, unloading first...");
    Bun.spawnSync(["launchctl", "unload", path], { stderr: "inherit" });
  }

  mkdirSync(getLogDir(), { recursive: true });
  writeFileSync(path, generatePlist());

  const result = Bun.spawnSync(["launchctl", "load", path], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    console.error("launchctl load failed");
    process.exit(1);
  }

  // Start immediately
  Bun.spawnSync(["launchctl", "start", PLIST_LABEL], { stderr: "inherit" });

  console.log(`\u2713 macOS launchd service installed and started`);
  console.log(`  plist: ${path}`);
  console.log(`  logs:  ${getLogDir()}/stderr.log`);
  console.log(`  manage: launchctl start|stop ${PLIST_LABEL}`);
  console.log(`  uninstall: omp-wechat uninstall`);
}

function uninstallLaunchd(): void {
  const path = plistPath();
  if (!existsSync(path)) {
    console.log("No launchd service found (may not be installed)");
    return;
  }

  Bun.spawnSync(["launchctl", "unload", path], { stderr: "inherit" });
  rmSync(path);
  console.log("\u2713 macOS launchd service uninstalled");
}

// --- Linux systemd ---

const SERVICE_NAME = "omp-wechat";

function servicePath(): string {
  return `/etc/systemd/system/${SERVICE_NAME}.service`;
}

function generateService(): string {
  const binary = getBinaryPath();
  const projectDir = getProjectDir();
  const logDir = getLogDir();
  const user = process.env.USER ?? "root";

  return `[Unit]
Description=OMP Wechat Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
WorkingDirectory=${projectDir}
ExecStart=${binary} run
Restart=always
RestartSec=10

# Logging
StandardOutput=append:${logDir}/stdout.log
StandardError=append:${logDir}/stderr.log

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${logDir} ${join(homedir(), ".omp-wechat")}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

function installSystemd(): void {
  const path = servicePath();

  // Stop old version if exists
  if (existsSync(path)) {
    logger.info("Found existing service, stopping first...");
    Bun.spawnSync(["sudo", "systemctl", "stop", SERVICE_NAME], { stderr: "inherit" });
  }

  mkdirSync(getLogDir(), { recursive: true });

  // Write to temp file then sudo mv (avoid direct sudo write permission issues)
  const tmp = `/tmp/${SERVICE_NAME}.service`;
  writeFileSync(tmp, generateService());

  const result = Bun.spawnSync(
    ["sudo", "te", tmp, path],
    { stderr: "inherit" },
  );
  // fallback: cp + rm
  if (result.exitCode !== 0) {
    Bun.spawnSync(["sudo", "cp", tmp, path], { stderr: "inherit" });
  }
  rmSync(tmp);

  Bun.spawnSync(["sudo", "systemctl", "daemon-reload"], { stderr: "inherit" });
  Bun.spawnSync(["sudo", "systemctl", "enable", "--now", SERVICE_NAME], { stderr: "inherit" });

  console.log(`\u2713 Linux systemd service installed and started`);
  console.log(`  unit:  ${path}`);
  console.log(`  logs:  ${getLogDir()}/stderr.log`);
  console.log(`  manage: sudo systemctl start|stop|status ${SERVICE_NAME}`);
  console.log(`  uninstall: omp-wechat uninstall`);
}

function uninstallSystemd(): void {
  const path = servicePath();
  if (!existsSync(path)) {
    console.log("No systemd service found (may not be installed)");
    return;
  }

  Bun.spawnSync(["sudo", "systemctl", "stop", SERVICE_NAME], { stderr: "inherit" });
  Bun.spawnSync(["sudo", "systemctl", "disable", SERVICE_NAME], { stderr: "inherit" });
  Bun.spawnSync(["sudo", "rm", path], { stderr: "inherit" });
  Bun.spawnSync(["sudo", "systemctl", "daemon-reload"], { stderr: "inherit" });

  console.log("\u2713 Linux systemd service uninstalled");
}

// --- Public API ---

export function installService(): void {
  const p = detectPlatform();

  switch (p) {
    case "darwin":
      installLaunchd();
      break;
    case "linux":
      installSystemd();
      break;
    default:
      console.error(`Platform ${p} does not support auto-installing a daemon`);
      console.error("Use tmux manually: tmux new -d -s omp-wechat './omp-wechat run'");
      process.exit(1);
  }
}

export function uninstallService(): void {
  const p = detectPlatform();

  switch (p) {
    case "darwin":
      uninstallLaunchd();
      break;
    case "linux":
      uninstallSystemd();
      break;
    default:
      console.error(`Platform ${p} does not support auto-uninstalling a daemon`);
      process.exit(1);
  }
}

/** Check daemon installation status */
export function serviceStatus(): void {
  const p = detectPlatform();

  switch (p) {
    case "darwin": {
      const exists = existsSync(plistPath());
      console.log(`Platform: macOS (launchd)`);
      console.log(`Service: ${exists ? "installed" : "not installed"}`);
      if (exists) {
        console.log(`plist: ${plistPath()}`);
        const r = Bun.spawnSync(["launchctl", "list", PLIST_LABEL], { stdout: "pipe", stderr: "pipe" });
        if (r.exitCode === 0) {
          console.log(`Status: ${r.stdout.toString().includes("PID") ? "running" : "stopped"}`);
        }
      }
      break;
    }
    case "linux": {
      const exists = existsSync(servicePath());
      console.log(`Platform: Linux (systemd)`);
      console.log(`Service: ${exists ? "installed" : "not installed"}`);
      if (exists) {
        console.log(`unit:  ${servicePath()}`);
        const r = Bun.spawnSync(["systemctl", "is-active", SERVICE_NAME], { stdout: "pipe", stderr: "pipe" });
        const active = r.stdout.toString().trim();
        console.log(`Status: ${active}`);
      }
      break;
    }
    default:
      console.log(`Platform: ${p} (daemon not supported)`);
  }

  console.log(`Binary: ${getBinaryPath()}`);
  console.log(`Logs:   ${getLogDir()}/stderr.log`);
}
