/**
 * Cross-platform boot-time service install/uninstall.
 *
 * Installs a launchd plist (macOS) or systemd service (Linux) that runs
 * the host binary (`omp --mode rpc` or `pi --mode rpc`) at boot. A
 * `get_state` JSON-RPC heartbeat is piped to stdin every 5s to keep
 * the process alive (omp exits on idle stdin without an RPC client).
 * launchd KeepAlive / systemd Restart=always handles crashes.
 * No external bun needed — the host is a standalone binary with an
 * embedded runtime.
 */
import { platform, homedir } from "os";
import { join, basename } from "path";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { logger } from "./utils/logger.js";

const PLIST_LABEL = "com.omp-wechat";
const SERVICE_NAME = "omp-wechat";

type Platform = "darwin" | "linux" | "win32" | "other";

function detectPlatform(): Platform {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "win32";
  return "other";
}

function getLogDir(): string {
  return join(homedir(), ".omp", "logs");
}

/** Resolve the host binary name (omp or pi) — not full path.
 *  The plist/systemd uses PATH to resolve it at runtime. */
function resolveHostBinary(): string {
  const exe = process.execPath || "omp";
  return basename(exe);
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
    <string>/bin/sh</string>
    <string>-c</string>
    <string>while true; do echo '{"id":"ka","type":"get_state"}'; sleep 5; done | exec ${omp} --mode rpc --no-title >/dev/null</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

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
ExecStart=/bin/sh -c 'while true; do echo "{\\"id\\":\\"ka\\",\\"type\\":\\"get_state\\"}"; sleep 5; done | exec ${omp} --mode rpc --no-title >/dev/null'
Restart=always
RestartSec=10

Environment=HOME=${homedir()}
Environment=PATH=/usr/local/bin:/usr/bin:/bin

StandardOutput=null
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

// --- Windows Task Scheduler ---

const WIN_TASK_NAME = "OMP-Wechat";

function winScriptPath(): string {
  return join(homedir(), ".omp-wechat", "omp-wechat-rpc.ps1");
}

function generateWinScript(): string {
  // Use full process.execPath — Task Scheduler's PATH is often more
  // restricted than an interactive terminal, so basename-only would
  // fail to resolve omp/pi on many installs.
  const omp = process.execPath || "omp";

  return `# OMP-Wechat RPC heartbeat wrapper — auto-generated by /wechat install
# Pipes a get_state JSON-RPC heartbeat to omp stdin every 5s to keep
# the --mode rpc process alive (omp exits on idle stdin without an RPC client).
# Outer while-loop restarts omp if it crashes, matching launchd KeepAlive
# and systemd Restart=always.
$ErrorActionPreference = 'Continue'
$ompPath = '${omp}'
$logPath = Join-Path $env:USERPROFILE '.omp\\logs\\rpc.log'
$logDir = Split-Path $logPath
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
while ($true) {
  $process = Start-Process -FilePath $ompPath -ArgumentList '--mode','rpc','--no-title' -NoNewWindow -PassThru -RedirectStandardError $logPath
  while ($true) {
    Write-Output '{"id":"ka","type":"get_state"}'
    Start-Sleep -Seconds 5
  } | $process
  # omp exited — wait 10s before restarting (backoff, matches systemd RestartSec=10)
  Start-Sleep -Seconds 10
}
`;
}

function installWinTask(): void {
  mkdirSync(join(homedir(), ".omp-wechat"), { recursive: true });
  mkdirSync(getLogDir(), { recursive: true });

  writeFileSync(winScriptPath(), generateWinScript());

  // Remove existing task if present (ignore errors)
  Bun.spawnSync(["schtasks", "/delete", "/tn", WIN_TASK_NAME, "/f"], { stderr: "ignore" });

  // Create scheduled task — runs at user logon, no admin required
  const scriptPath = winScriptPath();
  const taskCmd = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`;
  const result = Bun.spawnSync(
    ["schtasks", "/create", "/tn", WIN_TASK_NAME, "/tr", taskCmd, "/sc", "onlogon", "/rl", "limited", "/f"],
    { stderr: "inherit" },
  );
  if (result.exitCode !== 0) {
    throw new Error("schtasks /create failed");
  }

  // Start it now — check exit code (P2 fix: was silently ignored)
  const runResult = Bun.spawnSync(["schtasks", "/run", "/tn", WIN_TASK_NAME], { stderr: "inherit" });
  if (runResult.exitCode !== 0) {
    logger.warn(`schtasks /run failed (exit ${runResult.exitCode}) — task will start at next logon`);
  }
}

function uninstallWinTask(): void {
  // Stop running instance first (P1 fix: was not stopping before delete)
  Bun.spawnSync(["schtasks", "/end", "/tn", WIN_TASK_NAME], { stderr: "ignore" });

  const result = Bun.spawnSync(["schtasks", "/delete", "/tn", WIN_TASK_NAME, "/f"], { stderr: "inherit" });
  if (result.exitCode !== 0) {
    throw new Error("Failed to delete scheduled task (may not be installed)");
  }
  const script = winScriptPath();
  if (existsSync(script)) {
    rmSync(script);
  }
}

function winTaskExists(): boolean {
  const r = Bun.spawnSync(["schtasks", "/query", "/tn", WIN_TASK_NAME, "/fo", "list"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return r.exitCode === 0;
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
    case "win32":
      installWinTask();
      return { platform: p, path: winScriptPath() };
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
    case "win32":
      uninstallWinTask();
      return { platform: p, path: winScriptPath() };
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
    case "win32":
      return winTaskExists();
    default:
      return false;
  }
}

export { detectPlatform };
