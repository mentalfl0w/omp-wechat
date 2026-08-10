/**
 * Outbound media pipeline: upload a local file to the WeChat CDN
 * (AES-128-ECB encrypted) and send it to a user via sendmessage.
 *
 * Wire format verified against the official iLink SDK
 * (corespeed-io/wechatbot, media/uploader.ts + message/builder.ts):
 *   1. POST /ilink/bot/getuploadurl  → upload URL params
 *   2. POST CDN /upload (ciphertext) → x-encrypted-param header
 *   3. POST /ilink/bot/sendmessage   → { type: 4, file_item } or { type: 2, image_item }
 */
import { createHash, randomBytes } from "crypto";
import { readFileSync, statSync } from "fs";
import { basename, extname } from "path";
import { logger } from "../utils/logger.js";
import { apiFetch, CHANNEL_VERSION, baseInfo } from "./client.js";
import { encryptAesEcb, generateAesKey } from "./cdn.js";
import type {
  Credentials,
  GetUploadUrlResponse,
  UploadedMedia,
} from "./types.js";
import { MediaType } from "./types.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const UPLOAD_MAX_RETRIES = 3;
const SEND_MAX_RETRIES = 2;

/** Image extensions routed to WeChat image items; everything else → file. */
const IMAGE_EXTENSIONS: Record<string, true> = {
  ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".bmp": true,
};

export type MediaSendResult =
  | { status: "sent"; mediaType: MediaType; bytes: number }
  | { status: "too-large"; bytes: number; maxBytes: number }
  | { status: "error"; error: string };

/** Categorize a filename into a CDN media type. */
export function mediaTypeFor(fileName: string): MediaType {
  return IMAGE_EXTENSIONS[extname(fileName).toLowerCase()]
    ? MediaType.IMAGE
    : MediaType.FILE;
}

/**
 * Upload a file to the WeChat CDN and send it to a user.
 * Returns a status — callers decide whether to notify the user on failure.
 */
export async function uploadAndSendFile(
  creds: Credentials,
  to: string,
  contextToken: string,
  filePath: string,
  maxSizeBytes = 100 * 1024 * 1024,
): Promise<MediaSendResult> {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    return { status: "error", error: `cannot stat: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (size <= 0) {
    return { status: "error", error: "empty file" };
  }
  if (size > maxSizeBytes) {
    return { status: "too-large", bytes: size, maxBytes: maxSizeBytes };
  }

  const fileName = basename(filePath);
  const mediaType = mediaTypeFor(fileName);
  const data = readFileSync(filePath);

  try {
    // 1. Encrypt + derive upload metadata
    const aesKey = generateAesKey();
    const ciphertext = encryptAesEcb(data, aesKey);
    const filekey = randomBytes(16).toString("hex");
    const rawMd5 = createHash("md5").update(data).digest("hex");

    // 2. Get CDN upload URL
    const uploadParams = await apiFetch(
      creds,
      "ilink/bot/getuploadurl",
      {
        filekey,
        media_type: mediaType,
        to_user_id: to,
        rawsize: data.length,
        rawfilemd5: rawMd5,
        filesize: ciphertext.length,
        no_need_thumb: true,
        aeskey: aesKey.toString("hex"),
        base_info: baseInfo(),
      },
      15000,
    ) as GetUploadUrlResponse;

    const uploadFullUrl = uploadParams.upload_full_url?.trim();
    if (!uploadFullUrl && !uploadParams.upload_param) {
      return { status: "error", error: "getuploadurl returned no upload URL" };
    }
    const uploadUrl = uploadFullUrl
      || `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParams.upload_param)}&filekey=${encodeURIComponent(filekey)}`;

    // 3. Upload ciphertext to CDN (retry on server errors; 4xx is final)
    let encryptQueryParam: string | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
          signal: AbortSignal.timeout(60_000),
        });
        if (resp.status >= 400 && resp.status < 500) {
          return {
            status: "error",
            error: `CDN upload client error ${resp.status}: ${resp.headers.get("x-error-message") ?? "rejected"}`,
          };
        }
        if (!resp.ok) {
          throw new Error(`CDN upload server error: ${resp.status}`);
        }
        encryptQueryParam = resp.headers.get("x-encrypted-param") ?? undefined;
        if (!encryptQueryParam) {
          throw new Error("CDN upload response missing x-encrypted-param header");
        }
        break;
      } catch (err) {
        lastError = err;
        if (attempt < UPLOAD_MAX_RETRIES) {
          logger.warn(`CDN upload attempt ${attempt}/${UPLOAD_MAX_RETRIES} failed, retrying:`, err);
          await Bun.sleep(1000 * attempt);
        }
      }
    }
    if (!encryptQueryParam) {
      return {
        status: "error",
        error: `CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      };
    }

    const media: UploadedMedia = {
      encrypt_query_param: encryptQueryParam,
      // Format B: base64(hex string) — the encoding the WeChat client
      // expects (official SDK: Buffer.from(key.toString('hex')).toString('base64')).
      // Format A (base64 of raw bytes) made the client fail to decrypt:
      // sendmessage returned ret=0 but the file was silently dropped.
      aes_key: Buffer.from(aesKey.toString("hex"), "utf8").toString("base64"),
      encrypt_type: 1,
    };

    // 4. Send as a media message item
    const item = mediaType === MediaType.IMAGE
      ? {
          type: 2,
          image_item: { media, mid_size: ciphertext.length },
        }
      : {
          type: 4,
          file_item: {
            media,
            file_name: fileName,
            len: String(data.length),
          },
        };

    let lastSendError: unknown;
    for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
      try {
        await apiFetch(
          creds,
          "ilink/bot/sendmessage",
          {
            msg: {
              from_user_id: "",
              to_user_id: to,
              // Reuse one client_id across retries for server-side dedup
              client_id: `omp-wechat-${Date.now()}-${randomBytes(4).toString("hex")}`,
              message_type: 2, // BOT
              message_state: 2, // FINISH
              item_list: [item],
              context_token: contextToken,
            },
            base_info: baseInfo(),
          },
          15000,
        );
        logger.info(`Sent ${mediaType === MediaType.IMAGE ? "image" : "file"} to ${to}: ${fileName} (${data.length} bytes)`);
        return { status: "sent", mediaType, bytes: data.length };
      } catch (err) {
        lastSendError = err;
        if (attempt < SEND_MAX_RETRIES) {
          logger.warn(`Send retry ${attempt + 1}/${SEND_MAX_RETRIES}:`, err);
          await Bun.sleep(1000 * (attempt + 1));
        }
      }
    }
    return {
      status: "error",
      error: `send failed: ${lastSendError instanceof Error ? lastSendError.message : String(lastSendError)}`,
    };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
