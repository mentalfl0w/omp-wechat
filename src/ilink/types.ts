/**
 * iLink Bot API type definitions
 * Based on official iLink SDK protocol types.
 */

/** CDN media download info — shared by all media types */
export interface CDNMedia {
  /** Encrypted query param for CDN download URL */
  encrypt_query_param?: string;
  /** AES key as base64 (raw 16 bytes or hex string) */
  aes_key?: string;
  /** Encryption type: 1 = AES-128-ECB */
  encrypt_type?: number;
  /** Server-provided full download URL (use directly if present) */
  full_url?: string;
}

/** Inbound message items (union type) */
export interface TextItem {
  type: 1;
  text_item: { text: string };
}

export interface ImageItem {
  type: 2;
  image_item: {
    /** AES key as 32-char hex string (preferred over media.aes_key) */
    aeskey?: string;
    /** CDN download info */
    media?: CDNMedia;
    /** Thumbnail CDN info */
    thumb_media?: CDNMedia;
    /** Image URL (direct, non-CDN) */
    url?: string;
    mid_size?: number;
    thumb_size?: number;
    thumb_height?: number;
    thumb_width?: number;
    hd_size?: number;
  };
}

export interface VoiceItem {
  type: 3;
  voice_item: {
    /** CDN download info */
    media?: CDNMedia;
    /** Server-side ASR transcription */
    text?: string;
    /** Playback duration in seconds */
    playtime?: number;
    encode_type?: number;
    bits_per_sample?: number;
    sample_rate?: number;
  };
}

export interface FileItem {
  type: 4;
  file_item: {
    /** CDN download info */
    media?: CDNMedia;
    file_name?: string;
    md5?: string;
    /** File size as string */
    len?: string;
  };
}

export interface VideoItem {
  type: 5;
  video_item: {
    /** CDN download info */
    media?: CDNMedia;
    /** Thumbnail CDN info */
    thumb_media?: CDNMedia;
    video_size?: number;
    play_length?: number;
    video_md5?: string;
  };
}

export type MessageItem = TextItem | ImageItem | VoiceItem | FileItem | VideoItem;

/** Inbound message */
export interface InboundMessage {
  message_type: number;
  from_user_id: string;
  to_user_id: string;
  context_token: string;
  create_time_ms?: number;
  item_list: MessageItem[];
}

/** getupdates response */
export interface GetUpdatesResponse {
  ret: number;
  errmsg?: string;
  msgs?: InboundMessage[];
  get_updates_buf?: string;
}

/** Login credentials */
export interface Credentials {
  token: string;
  baseUrl: string;
  userId?: string;
  accountId?: string;
}

/** QR code fetch response */
export interface QrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

/** QR code login status */
export interface QrCodeStatus {
  status: "wait" | "scaned" | "expired" | "confirmed";
  bot_token?: string;
  baseurl?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
}

/** getconfig response (typing ticket) */
export interface GetConfigResponse {
  ret: number;
  errmsg?: string;
  typing_ticket?: string;
}
