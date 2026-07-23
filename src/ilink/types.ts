/**
 * iLink Bot API type definitions
 */

/** Inbound message items (union type) */
export interface TextItem {
  type: 1;
  text_item: { text: string };
}

export interface ImageItem {
  type: 2;
  image_item: {
    file_url?: string;
    aes_key?: string;
    file_size?: number;
  };
}

export interface VoiceItem {
  type: 3;
  voice_item: {
    text?: string;
    file_url?: string;
    duration?: number;
  };
}

export interface FileItem {
  type: 4;
  file_item: {
    file_name: string;
    file_url?: string;
    file_size?: number;
  };
}

export interface VideoItem {
  type: 5;
  video_item: {
    file_url?: string;
    thumb_url?: string;
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
