/**
 * CDN media download + AES-128-ECB decryption for iLink inbound media.
 *
 * WeChat CDN media is encrypted with AES-128-ECB + PKCS7 padding.
 * The AES key comes in two encodings depending on media type:
 *   - Images: `image_item.aeskey` (32-char hex string) — preferred
 *   - Fallback: `image_item.media.aes_key` (base64 of 16 raw bytes, or base64 of hex string)
 *
 * CDN URLs need no auth — they're pre-signed via `encrypted_query_param`.
 */
import { createDecipheriv } from "node:crypto";
import { logger } from "../utils/logger.js";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

/** Parse an AES-128 key from the various iLink encodings. */
export function parseAesKey(
  aeskeyHex?: string,
  aesKeyBase64?: string,
): Buffer | null {
  // Preferred: 32-char hex string from image_item.aeskey
  if (aeskeyHex && /^[0-9a-fA-F]{32}$/.test(aeskeyHex)) {
    return Buffer.from(aeskeyHex, "hex");
  }

  if (!aesKeyBase64) return null;

  const decoded = Buffer.from(aesKeyBase64, "base64");

  // Format A: base64(raw 16 bytes)
  if (decoded.length === 16) return decoded;

  // Format B: base64(hex string of 16 bytes) → 32 chars
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }

  return null;
}

/** Decrypt AES-128-ECB ciphertext with PKCS7 padding. */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Build a CDN download URL.
 * Prefers full_url (server-provided direct URL), falls back to
 * constructing from encrypt_query_param.
 */
function buildCdnUrl(encryptQueryParam?: string, fullUrl?: string): string | null {
  if (fullUrl) return fullUrl;
  if (!encryptQueryParam) return null;
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/**
 * Download and decrypt a media file from WeChat CDN.
 * Returns the plaintext Buffer, or null on failure.
 */
export async function downloadAndDecrypt(
  encryptQueryParam?: string,
  fullUrl?: string,
  aeskeyHex?: string,
  aesKeyBase64?: string,
  label = "media",
): Promise<Buffer | null> {
  const url = buildCdnUrl(encryptQueryParam, fullUrl);
  if (!url) {
    logger.warn(`[${label}] No CDN URL available`);
    return null;
  }

  const key = parseAesKey(aeskeyHex, aesKeyBase64);
  if (!key) {
    logger.warn(`[${label}] Could not parse AES key`);
    return null;
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      logger.warn(`[${label}] CDN download failed: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const encrypted = Buffer.from(await resp.arrayBuffer());
    const plaintext = decryptAesEcb(encrypted, key);
    logger.info(`[${label}] Downloaded + decrypted: ${encrypted.length} → ${plaintext.length} bytes`);
    return plaintext;
  } catch (err: unknown) {
    logger.error(`[${label}] CDN download/decrypt error:`, err);
    return null;
  }
}
