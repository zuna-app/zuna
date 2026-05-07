import { ReplyInfo } from "@/types/serverTypes";

export const WS_MSG = {
  AUTH: "auth",
  AUTH_CONFIRMATION: "auth_confirmation",
  PRESENCE: "presence",
  PRESENCE_REQUEST: "presence_request",
  PRESENCE_UPDATE: "presence_update",
  PRESENCE_RESPONSE: "presence_response",
  PING: "ping",
  PONG: "pong",
  MESSAGE: "message",
  MESSAGE_ACK: "message_ack",
  MESSAGE_RECEIVE: "message_receive",
  MESSAGE_READ_INFO: "message_read_info",
  MESSAGE_DELETE: "message_delete",
  MESSAGE_DELETE_RECEIVE: "message_delete_receive",
  MESSAGE_MODIFY: "message_modify",
  MESSAGE_MODIFY_RECEIVE: "message_modify_receive",
  MESSAGE_PIN: "message_pin",
  MESSAGE_PIN_RECEIVE: "message_pin_receive",
  MARK_READ: "mark_read",
  WRITE: "write",
  WRITE_RECEIVE: "write_receive",
  ERROR: "error",
  USER_JOINED: "user_joined",
  // Channel messages
  CHANNEL_MESSAGE: "channel_message",
  CHANNEL_MESSAGE_ACK: "channel_message_ack",
  CHANNEL_MESSAGE_RECEIVE: "channel_message_receive",
  CHANNEL_WRITE: "channel_write",
  CHANNEL_WRITE_RECEIVE: "channel_write_receive",
  CHANNEL_KEY_RECEIVE: "channel_key_receive",
  CHANNEL_KEY_REQUESTS: "channel_key_requests",
  CHANNEL_KEY_PROVIDE: "channel_key_provide",
} as const;

export type WsMsgType = (typeof WS_MSG)[keyof typeof WS_MSG];

export interface MemberPresence {
  userId: string;
  active: boolean;
  lastSeen: number;
}

export interface PresenceUpdatePayload {
  presence: {
    user_id: string;
    active: boolean;
    last_seen: number;
  };
}

export interface PresenceResponsePayload {
  presence: Array<{
    user_id: string;
    active: boolean;
    last_seen: number;
  }>;
}

export interface ErrorPayload {
  code: string;
  message?: string;
}

export interface MessageAckPayload {
  id: number;
  client_message_id: string;
  chat_id: string;
  created_at: number;
  attachment_id?: string;
  attachment_metadata?: string;
  attachment_metadata_iv?: string;
  attachment_metadata_auth_tag?: string;
  is_reply: boolean;
  reply_info?: ReplyInfo;
}

export interface MessageReceivePayload {
  id: number;
  client_message_id: string;
  chat_id: string;
  created_at: number;
  sender_id: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  attachment_id?: string;
  attachment_metadata?: string;
  attachment_metadata_iv?: string;
  attachment_metadata_auth_tag?: string;
  modified: boolean;
  pinned: boolean;
  is_reply: boolean;
  reply_info?: ReplyInfo;
}

export interface MessageReadInfoPayload {
  chat_id: string;
}

export interface MessageDeletePayload {
  id: number;
}

export interface MessageDeleteReceivePayload {
  id: number;
}

export interface MessageModifyPayload {
  id: number;
  cipher_text: string;
  iv: string;
  auth_tag: string;
}

export interface MessageModifyReceivePayload {
  id: number;
  chat_id: string;
  sender_id: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
}

export interface MessagePinPayload {
  id: number;
}

export interface MessagePinReceivePayload {
  id: number;
  pinned: boolean;
}

export interface PongPayload {
  ts: number;
}

export interface WriteReceivePayload {
  chat_id: string;
  sender_id: string;
  writing: boolean;
}

export interface ChannelMessageAckPayload {
  client_message_id: string;
  id: number;
  channel_id: string;
  sent_at: number;
  attachment_id?: string;
  attachment_metadata?: string;
  attachment_metadata_iv?: string;
  attachment_metadata_auth_tag?: string;
}

export interface ChannelMessageReceivePayload {
  id: number;
  client_message_id: string;
  channel_id: string;
  sender_id: string;
  sender_username: string;
  sender_avatar: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  sent_at: number;
  attachment_id?: string;
  attachment_metadata?: string;
  attachment_metadata_iv?: string;
  attachment_metadata_auth_tag?: string;
}

export interface ChannelWriteReceivePayload {
  channel_id: string;
  sender_id: string;
  sender_username: string;
  writing: boolean;
}

export interface ChannelKeyRequestsPayload {
  requests: Array<{
    channel_id: string;
    recipient_user_id: string;
    recipient_identity_key: string;
  }>;
}
