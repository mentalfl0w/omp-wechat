import { saveCredentials } from "./client.js";
import type { Credentials, QrCodeStatus, QrCodeResponse } from "./types.js";
import { logger } from "../utils/logger.js";
import { addToAllowlist } from "../access/control.js";
import qt from "qrcode-terminal";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com/";
const POLL_INTERVAL_MS = 3000;
const TIMEOUT_MS = 5 * 60_000;

/**
 * QR code login flow:
 * 1. Fetch QR code
 * 2. Render in terminal
 * 3. Poll status until confirmed/expired/timeout
 * 4. Save credentials + auto-authorize the logged-in user
 */
export async function login(): Promise<void> {
  const baseUrl = DEFAULT_BASE_URL;

  // Step 1: fetch QR code
  logger.info("Fetching QR code...");
  const qrRes = await fetch(`${baseUrl}ilink/bot/get_bot_qrcode?bot_type=3`);
  if (!qrRes.ok) {
    logger.error(`Failed to fetch QR code: ${qrRes.status}`);
    process.exit(1);
  }

  const qrData = (await qrRes.json()) as QrCodeResponse;
  const qrcodeToken: string = qrData.qrcode;
  const qrUrl: string = qrData.qrcode_img_content;

  if (!qrcodeToken || !qrUrl) {
    logger.error("Invalid QR code data", qrData);
    process.exit(1);
  }

  // Step 2: render QR code in terminal
  try {
    qt.generate(qrUrl, { small: true });
  } catch {
    logger.info("Installing qrcode-terminal...");
    Bun.spawnSync(["bun", "install", "qrcode-terminal"], {
      cwd: process.cwd(),
      stderr: "inherit",
    });
    qt.generate(qrUrl, { small: true });
  }

  process.stderr.write(`\nScan the QR code above with WeChat, or open this link:\n\n  ${qrUrl}\n\n`);

  // Step 3: poll status
  const deadline = Date.now() + TIMEOUT_MS;
  let scannedShown = false;

  while (Date.now() < deadline) {
    const status = await pollQrStatus(qrcodeToken, baseUrl);

    switch (status.status) {
      case "wait":
        break;

      case "scaned":
        if (!scannedShown) {
          logger.info("Scanned, waiting for confirmation...");
          scannedShown = true;
        }
        break;

      case "expired":
        logger.error("QR code expired, please run login again");
        process.exit(1);

      case "confirmed": {
        const creds: Credentials = {
          token: status.bot_token ?? "",
          baseUrl: status.baseurl ?? baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
        };

        if (!creds.token) {
          logger.error("Login response missing bot_token");
          process.exit(1);
        }

        saveCredentials(creds);

        // Auto-authorize the logged-in user
        if (creds.userId) {
          addToAllowlist(creds.userId);
          logger.info(`Login successful, user ${creds.userId} auto-authorized`);
        } else {
          logger.info("Login successful");
        }

        return;
      }
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  logger.error("Login timeout, please run login again");
  process.exit(1);
}

async function pollQrStatus(
  qrcode: string,
  baseUrl: string,
): Promise<QrCodeStatus> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);

  try {
    const res = await fetch(
      `${baseUrl}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { signal: controller.signal },
    );
    clearTimeout(timer);
    if (!res.ok) throw new Error(`poll failed: ${res.status}`);
    return (await res.json()) as QrCodeStatus;
  } catch (err: unknown) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}
