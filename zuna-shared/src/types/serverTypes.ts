export type ServerList = Server[];

export interface Server {
  id: string;
  address: string;
  name: string;
  username: string;
  publicKey: string | null;
  serverId: string | null;
}

export interface ChatMemberRaw {
  id: string;
  chatId: string;
  username: string;
  avatar: string;
  identityKey: string;
}

export type ChatMember = ChatMemberRaw & {
  senderId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  unreadMessages: number;
  lastActivityAt: number;
};

export interface LastMessage {
  chatId: string;
  senderId: string;
  content: string;
  unreadMessages: number;
  lastActivityAt: number;
}

export interface Chat {
  members: ChatMember[];
}

export type Message = {
  id: number | null;
  localId: number | null;
  chatId: string;
  cipherText: string;
  iv: string;
  authTag: string;
  sentAt: number;
  readAt?: number;
  senderId: string;
  isOwn: boolean;
  pending: boolean;
  plaintext?: string;
  attachmentId?: string;
  attachmentMetadata?: string;
  attachmentMetadataIv?: string;
  attachmentMetadataAuthTag?: string;
  /** Plaintext filename for local upload-in-progress messages */
  attachmentFilename?: string;
  /** 0-100 while uploading; undefined once WS ack has been received */
  uploadProgress?: number;
  modified: boolean;
  pinned: boolean;
  isReply: boolean;
  replyInfo?: ReplyInfo;
};

export type RawMessageDTO = {
  id: number;
  sender_id: string;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  sent_at: number;
  read_at: number;
  attachment_id?: string;
  attachment_metadata?: string;
  attachment_metadata_iv?: string;
  attachment_metadata_auth_tag?: string;
  modified: boolean;
  pinned?: boolean;
  pin?: boolean;
  is_reply: boolean;
  reply_info?: ReplyInfo;
};

export type ReplyInfo = {
  id: number;
  cipher_text: string;
  iv: string;
  auth_tag: string;
  has_attachment: boolean;
};
