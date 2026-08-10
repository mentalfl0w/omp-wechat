import { randomBytes } from "crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
} from "fs";
import { homedir } from "os";
import { join } from "path";
import type {
  Credentials,
  GetUpdatesResponse,
  InboundMessage,
  GetConfigResponse,
  ImageItem,
} from "./types.js";
import { logger } from "../utils/logger.js";

const STATE_DIR = join(homedir(), ".omp-wechat");
const CREDENTIALS_FILE = join(STATE_DIR, "credentials.json");
const SYNC_BUF_FILE = join(STATE_DIR, "sync_buf.txt");

/**
 * Channel version declared to the iLink server.
 *
 * This is the PROTOCOL baseline this project implements — it must track
 * the official iLink SDK (corespeed-io/wechatbot), not this package's
 * own version. Currently implements the wire protocol of the official
 * SDK v2.2.0; bump when adopting a newer official release. Older values
 * (0.1.0) accepted text but rejected media messages server-side.
 */
export const CHANNEL_VERSION = "2.2.0";

// --- Credential management ---

export function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(readFileSync(CREDENTIALS_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = CREDENTIALS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, CREDENTIALS_FILE);
}

export function getCredentials(): Credentials {
  const creds = loadCredentials();
  if (!creds?.token || !creds?.baseUrl) {
    throw new Error("Not logged in — run /wechat login");
  }
  return creds;
}

export function getStateDir(): string {
  return STATE_DIR;
}

// --- HTTP helpers ---

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

export async function apiFetch(
  creds: Credentials,
  endpoint: string,
  body: object,
  timeoutMs = 15000,
): Promise<unknown> {
  const baseUrl = creds.baseUrl.endsWith("/")
    ? creds.baseUrl
    : `${creds.baseUrl}/`;
  const url = new URL(endpoint, baseUrl);
  const bodyStr = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...buildHeaders(creds.token),
        "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
      },
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`);
    const data = JSON.parse(text) as Record<string, unknown>;
    // iLink business-level errors come back as HTTP 200 with ret/errcode
    // set — without this check failures were silently treated as success.
    const ret = typeof data.ret === "number" ? data.ret : undefined;
    const errcode = typeof data.errcode === "number" ? data.errcode : undefined;
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
      const code = errcode ?? ret ?? 0;
      const errmsg = typeof data.errmsg === "string" ? data.errmsg : "";
      throw new Error(`${endpoint} error ret=${ret} errcode=${errcode}${errmsg ? `: ${errmsg}` : ""} (code ${code})`);
    }
    return data;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// --- Receive messages (long-poll) ---

export async function getUpdates(
  creds: Credentials,
  buf: string,
): Promise<GetUpdatesResponse> {
  try {
    const resp = await apiFetch(
      creds,
      "ilink/bot/getupdates",
      {
        get_updates_buf: buf,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      35000,
    );
    return resp as GetUpdatesResponse;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

// --- Send message ---

export async function sendMessage(
  creds: Credentials,
  to: string,
  text: string,
  contextToken: string,
  clientId?: string,
): Promise<void> {
  await apiFetch(
    creds,
    "ilink/bot/sendmessage",
    {
      msg: {
        from_user_id: "",
        to_user_id: to,
        // Reuse caller-provided client_id across retries so the server
        // can de-duplicate when a timeout fires after the message was
        // already accepted.
        client_id: clientId ?? `omp-wechat-${Date.now()}-${randomBytes(4).toString("hex")}`,
        message_type: 2, // BOT
        message_state: 2, // FINISH
        item_list: [{ type: 1, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: { channel_version: CHANNEL_VERSION },
    },
    15000,
  );
}

// --- Typing indicator ---

const typingTicketCache = new Map<string, { ticket: string; expiresAt: number }>();
const TYPING_TICKET_TTL_MS = 20 * 60 * 60 * 1000; // ~20 hours

async function ensureTypingTicket(
  creds: Credentials,
  userId: string,
): Promise<string | null> {
  const cached = typingTicketCache.get(userId);
  if (cached && Date.now() < cached.expiresAt) return cached.ticket;

  try {
    const resp = await apiFetch(
      creds,
      "ilink/bot/getconfig",
      {
        ilink_user_id: userId,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      15000,
    );
    const data = resp as GetConfigResponse;
    if (data.typing_ticket) {
      typingTicketCache.set(userId, {
        ticket: data.typing_ticket,
        expiresAt: Date.now() + TYPING_TICKET_TTL_MS,
      });
      return data.typing_ticket;
    }
  } catch (err: unknown) {
    logger.debug(`Failed to get typing ticket for ${userId}: ${err}`);
  }
  return null;
}

/**
 * Send typing indicator.
 * command: 1 = show "typing...", 2 = cancel
 */
export async function sendTyping(
  creds: Credentials,
  userId: string,
  command: 1 | 2,
): Promise<void> {
  const ticket = await ensureTypingTicket(creds, userId);
  if (!ticket) return;

  try {
    await apiFetch(
      creds,
      "ilink/bot/sendtyping",
      {
        ilink_user_id: userId,
        typing_ticket: ticket,
        // Field is `status` in the official SDK (1 = show, 2 = cancel)
        status: command,
        base_info: { channel_version: CHANNEL_VERSION },
      },
      10000,
    );
  } catch (err: unknown) {
    // Typing is best-effort; don't let failures block the main flow
    logger.debug(`sendTyping failed for ${userId}: ${err}`);
  }
}

// --- Sync buffer persistence ---

export function loadSyncBuf(): string {
  try {
    return readFileSync(SYNC_BUF_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

export function saveSyncBuf(buf: string): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(SYNC_BUF_FILE, buf);
}

/** Format a byte count as a human-readable size (e.g. 1.2MB). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// --- Inbound message text extraction ---

export function extractInboundText(msg: InboundMessage, includeImagePlaceholder = true): string {
  const items = msg.item_list ?? [];
  const parts: string[] = [];
  let imgCount = 0;

  for (const item of items) {
    switch (item.type) {
      case 1:
        if (item.text_item?.text) parts.push(item.text_item.text);
        break;
      case 2:
        imgCount++;
        break;
      case 3:
        parts.push(item.voice_item?.text ?? "(voice)");
        break;
      case 4:
        // Enriched with size; text content itself is downloaded separately
        // (see bridge.downloadFileTexts) so binary files stay a placeholder.
        {
          const name = item.file_item?.file_name ?? "unknown";
          const len = parseInt(item.file_item?.len ?? "", 10);
          parts.push(`(file: ${name}${Number.isFinite(len) && len > 0 ? ", " + formatSize(len) : ""})`);
        }
        break;
      case 5:
        parts.push("(video)");
        break;
    }
  }

  if (includeImagePlaceholder && imgCount > 0 && parts.length === 0) {
    parts.push(`(user sent ${imgCount} image${imgCount > 1 ? "s" : ""})`);
  } else if (includeImagePlaceholder && imgCount > 0) {
    parts.push(`(+${imgCount} image${imgCount > 1 ? "s" : ""})`);
  }

  return parts.join("\n") || "";
}

/**
 * Extract image items from an inbound message for CDN download.
 * Returns the raw ImageItem objects — caller handles download+decrypt.
 */
export function extractInboundImages(msg: InboundMessage): ImageItem[] {
  return (msg.item_list ?? []).filter(
    (item): item is ImageItem => item.type === 2,
  );
}
