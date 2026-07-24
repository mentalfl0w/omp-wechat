/**
 * Cross-platform boot-time service install/uninstall.
 *
 * Installs a launchd plist (macOS) or systemd service (Linux) that runs
 * the host binary (`omp --mode rpc` or `pi --mode rpc`) at boot. The host
 * stays alive (launchd KeepAlive / systemd Restart=always), loads the
 * extension, fires session_start, and the poll loop runs in-process.
 * No external bun needed — the host is a standalone binary with an
 * embedded runtime.
 */
import { platform, homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";

const PLIST_LABEL = "com.omp-wechat";
const SERVICE_NAME = "omp-wechat";

type Platform = "darwin" | "linux" | "other";

function detectPlatform(): Platform {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "other";
}

function getLogDir(): string {
  return join(homedir(), ".omp", "logs");
}

/** Resolve the host binary path (omp or pi). */
function resolveHostBinary(): string {
  return process.execPath || "omp";
}

// --- macOS launchd ---

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
}

function generatePlist(): string {
  const omp = resolveHostBinary();
  const logDir = getLogDir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${omp}</string>
    <string>--mode</string>
    <string>rpc</string>
    <string>--no-title</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardInputPath</key>
  <string>/dev/null</string>

  <key>StandardOutPath</key>
  <string>${logDir}/rpc.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/rpc.log</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
</dict>
</plist>
`;
}

function installLaunchd(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  mkdirSync(getLogDir(), { recursive: true });

  const plist = plistPath();
  if (existsSync(plist)) {
    Bun.spawnSync(["launchctl", "unload", plist], { stderr: "ignore" });
  }

  writeFileSync(plist, generatePlist());

  const result = Bun.spawnSync(["launchctl", "load", plist], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error("launchctl load failed");
  }

  Bun.spawnSync(["launchctl", "start", PLIST_LABEL], { stderr: "inherit" });
}

function uninstallLaunchd(): void {
  const plist = plistPath();
  if (!existsSync(plist)) {
    throw new Error("No launchd service found (may not be installed)");
  }

  Bun.spawnSync(["launchctl", "unload", plist], { stderr: "inherit" });
  rmSync(plist);
}

// --- Linux systemd ---

function servicePath(): string {
  return `/etc/systemd/system/${SERVICE_NAME}.service`;
}

function generateService(): string {
  const omp = resolveHostBinary();
  const logDir = getLogDir();
  const user = process.env.USER ?? "root";

  return `[Unit]
Description=OMP WeChat Bridge (RPC)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
Group=${user}
ExecStart=${omp} --mode rpc --no-title
StandardInput=null
Restart=always
RestartSec=10

Environment=HOME=${homedir()}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

StandardOutput=append:${logDir}/rpc.log
StandardError=append:${logDir}/rpc.log

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${logDir} ${join(homedir(), ".omp-wechat")} ${join(homedir(), ".omp")}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

function installSystemd(): void {
  const svc = servicePath();
  mkdirSync(getLogDir(), { recursive: true });

  if (existsSync(svc)) {
    Bun.spawnSync(["sudo", "systemctl", "stop", SERVICE_NAME], { stderr: "inherit" });
  }

  const tmp = `/tmp/${SERVICE_NAME}.service`;
  writeFileSync(tmp, generateService());

  let result = Bun.spawnSync(["sudo", "te", tmp, svc], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    result = Bun.spawnSync(["sudo", "cp", tmp, svc], { stderr: "inherit" });
  }
  rmSync(tmp);

  if (result.exitCode !== 0) {
    throw new Error("Failed to write service file (need sudo)");
  }

  Bun.spawnSync(["sudo", "systemctl", "daemon-reload"], { stderr: "inherit" });
  result = Bun.spawnSync(["sudo", "systemctl", "enable", "--now", SERVICE_NAME], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error("systemctl enable failed");
  }
}

function uninstallSystemd(): void {
  const svc = servicePath();
  if (!existsSync(svc)) {
    throw new Error("No systemd service found (may not be installed)");
  }

  Bun.spawnSync(["sudo", "systemctl", "stop", SERVICE_NAME], { stderr: "inherit" });
  Bun.spawnSync(["sudo", "systemctl", "disable", SERVICE_NAME], { stderr: "inherit" });
  Bun.spawnSync(["sudo", "rm", svc], { stderr: "inherit" });
  Bun.spawnSync(["sudo", "systemctl", "daemon-reload"], { stderr: "inherit" });
}

// --- Public API ---

export interface InstallResult {
  platform: Platform;
  path: string;
}

export function installService(): InstallResult {
  const p = detectPlatform();
  switch (p) {
    case "darwin":
      installLaunchd();
      return { platform: p, path: plistPath() };
    case "linux":
      installSystemd();
      return { platform: p, path: servicePath() };
    default:
      throw new Error(`Platform ${p} does not support auto-installing a boot service`);
  }
}

export function uninstallService(): InstallResult {
  const p = detectPlatform();
  switch (p) {
    case "darwin":
      uninstallLaunchd();
      return { platform: p, path: plistPath() };
    case "linux":
      uninstallSystemd();
      return { platform: p, path: servicePath() };
    default:
      throw new Error(`Platform ${p} does not support auto-uninstalling a boot service`);
  }
}

export function isServiceInstalled(): boolean {
  const p = detectPlatform();
  switch (p) {
    case "darwin":
      return existsSync(plistPath());
    case "linux":
      return existsSync(servicePath());
    default:
      return false;
  }
}

export { detectPlatform };
