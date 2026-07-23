import { randomBytes } from "crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import { logger } from "../utils/logger.js";

const STATE_DIR = join(homedir(), ".omp-wechat");
const ACCESS_FILE = join(STATE_DIR, "access.json");

export type DmPolicy = "pairing" | "allowlist" | "disabled";

export interface PendingEntry {
  senderId: string;
  createdAt: number;
  expiresAt: number;
  replies: number;
}

export interface AccessConfig {
  dmPolicy: DmPolicy;
  allowFrom: string[];
  pending: Record<string, PendingEntry>;
}

function defaultAccess(): AccessConfig {
  return { dmPolicy: "pairing", allowFrom: [], pending: {} };
}

function readAccessFile(): AccessConfig {
  try {
    const raw = readFileSync(ACCESS_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AccessConfig>;
    return {
      dmPolicy: parsed.dmPolicy ?? "pairing",
      allowFrom: parsed.allowFrom ?? [],
      pending: parsed.pending ?? {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultAccess();
    // Move corrupt file aside
    try {
      renameSync(ACCESS_FILE, `${ACCESS_FILE}.corrupt-${Date.now()}`);
    } catch {}
    logger.warn("access.json is corrupt, moved aside, using defaults");
    return defaultAccess();
  }
}

function saveAccess(a: AccessConfig): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = ACCESS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(a, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, ACCESS_FILE);
}

export function loadAccess(): AccessConfig {
  return readAccessFile();
}

/** Add a user to the allowlist */
export function addToAllowlist(userId: string): void {
  const access = loadAccess();
  if (!access.allowFrom.includes(userId)) {
    access.allowFrom.push(userId);
    saveAccess(access);
  }
}

/** Remove a user from the allowlist */
export function revokeFromAllowlist(userId: string): boolean {
  const access = loadAccess();
  const idx = access.allowFrom.indexOf(userId);
  if (idx === -1) return false;
  access.allowFrom.splice(idx, 1);
  saveAccess(access);
  return true;
}

/** Approve a pairing code */
export function approvePairing(code: string): boolean {
  const access = loadAccess();
  const pending = access.pending[code];
  if (!pending) return false;

  if (!access.allowFrom.includes(pending.senderId)) {
    access.allowFrom.push(pending.senderId);
  }
  delete access.pending[code];
  saveAccess(access);
  logger.info(`Pairing ${code} approved, user ${pending.senderId} authorized`);
  return true;
}

export type GateResult =
  | { action: "deliver" }
  | { action: "drop" }
  | { action: "pair"; code: string; isResend: boolean };

/** Access control gate: decide whether to deliver, drop, or require pairing */
export function gate(senderId: string): GateResult {
  const access = loadAccess();

  // Prune expired pairings
  const now = Date.now();
  let changed = false;
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.expiresAt < now) {
      delete access.pending[code];
      changed = true;
    }
  }
  if (changed) saveAccess(access);

  if (!senderId) return { action: "drop" };

  if (access.dmPolicy === "disabled") return { action: "drop" };
  if (access.allowFrom.includes(senderId)) return { action: "deliver" };
  if (access.dmPolicy === "allowlist") return { action: "drop" };

  // Pairing mode
  for (const [code, p] of Object.entries(access.pending)) {
    if (p.senderId === senderId) {
      if ((p.replies ?? 1) >= 2) return { action: "drop" };
      p.replies = (p.replies ?? 1) + 1;
      saveAccess(access);
      return { action: "pair", code, isResend: true };
    }
  }

  // Cap pending pairings
  if (Object.keys(access.pending).length >= 3) return { action: "drop" };

  const code = randomBytes(3).toString("hex");
  access.pending[code] = {
    senderId,
    createdAt: now,
    expiresAt: now + 60 * 60 * 1000, // 1 hour
    replies: 1,
  };
  saveAccess(access);
  return { action: "pair", code, isResend: false };
}

/** List authorized users */
export function listAllowed(): string[] {
  return loadAccess().allowFrom;
}
