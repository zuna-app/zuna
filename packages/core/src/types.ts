// Shapes shared between the client core and the UI.

export type Role = "owner" | "admin" | "member";
export type GroupRole = "admin" | "member";
export type GroupKind = "dm" | "group";

export interface ServerInfo {
  name: string;
  version: string;
  has_icon: boolean;
  claimed: boolean;
  registration: "invite" | "open";
  max_upload_mb: number;
  allow_member_invites: boolean;
  retention_days: number;
  emote_set_id: string;
  emote_set_name: string;
  user_count: number;
  community_key?: string;
  /** Whether this server keeps generations of account keys. Absent on one that doesn't. */
  account_protocol?: number;
}

export interface InvitePreview {
  url: string;
  code: string;
  communityKey: string | null;
  setup: boolean;
  server: ServerInfo;
}

export interface Invite {
  code: string;
  created_by: string;
  grants_role: string;
  max_uses: number;
  uses: number;
  expires_at: number | null;
  created_at: number;
}

export interface AvatarRef {
  fileId: string;
  key: string;
  prefix: string;
  chunks: number;
  mime: string;
}

export interface Profile {
  displayName: string;
  bio?: string;
  avatar?: AvatarRef | null;
}

/** How far a contact's identity key has been checked. */
export type TrustState = "unverified" | "verified" | "changed";

export interface UserView {
  id: string;
  username: string;
  role: Role;
  displayName: string;
  bio: string;
  avatar: AvatarRef | null;
  online: boolean;
  lastSeenAt: number | null;
  hidesLastSeen: boolean;
  banned: boolean;
  trust: TrustState;
  isSelf: boolean;
}

export interface Attachment {
  fileId: string;
  key: string;
  prefix: string;
  chunks: number;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  /** Tiny inline preview shown while the full image loads (data URL). */
  thumb?: string;
  duration?: number;
  /** Recorded in the app, so it plays as a voice message. */
  voice?: boolean;
  /** A voice message's loudness over time: one byte (0 to 255) per bar, base64. */
  waveform?: string;
}

export interface EmoteRef {
  id: string;
  animated?: boolean;
  zeroWidth?: boolean;
  /** Who made the emote on 7TV, kept so it still shows if the set changes. */
  owner?: string;
}

/** Where a server wakes this device for new messages: through a push relay, sealed with a key. */
export interface PushSettings {
  /** The relay's address, one the server must allow. */
  relay: string;
  /** The relay's handle for this device. */
  handle: string;
  /** Seals each push, so the relay sees only that one arrived. */
  key: Uint8Array;
  /** The app's own ID for this registration, so it knows which server a push is from. */
  registration: string;
  /** Tell the server which chats are muted, so it skips them, for an app that can't hide notifications itself. */
  sendMuted: boolean;
}

export interface MessageBody {
  text?: string;
  replyTo?: string;
  emotes?: Record<string, EmoteRef>;
  attachments?: Attachment[];
  mentions?: string[];
  /** The preview of the first link in the text, made by the sender's device. */
  preview?: LinkPreview;
  forwarded?: ForwardInfo;
  /** When the sender's device sent it (ms), signed with the rest, unlike the server's time. */
  sentAt?: number;
}

/**
 * A link's preview. The sender's device fetches the page and sends what it
 * found inside the message, so recipients never contact the site and the
 * server never sees the link.
 */
export interface LinkPreview {
  /** The link as it appears in the message's text. */
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  /** The page's picture, shrunk to a small JPEG, as a data URL. */
  image?: { data: string; width: number; height: number };
}

/** Marks a forwarded message: whose it was on the same server, or nobody named when it came from another server. */
export interface ForwardInfo {
  userId?: string;
}

export interface ReactionView {
  /** The unicode emoji, or an emote's name. */
  key: string;
  emote?: EmoteRef;
  userIds: string[];
}

/**
 * "unverified": its signature failed, or it couldn't have been sent when it claims.
 * "invalid": it opened, but what's inside isn't a message this app can show.
 */
export type MessageStatus = "sending" | "sent" | "failed" | "undecryptable" | "unverified" | "invalid";

export interface SystemEvent {
  type:
    | "member_added"
    | "member_removed"
    | "member_left"
    | "member_rejoined"
    | "device_added"
    | "unexpected_join"
    | "identity_changed"
    | "identity_rotated"
    | "group_created";
  actorId?: string;
  targetIds?: string[];
}

export interface ReplyPreview {
  id: string;
  senderId: string;
  text: string;
  hasAttachment: boolean;
  deleted: boolean;
}

export interface MessageView {
  id: string;
  groupId: string;
  seq: number | null;
  senderId: string;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
  pinnedAt: number | null;
  pinnedBy: string | null;
  status: MessageStatus;
  text: string;
  emotes: Record<string, EmoteRef>;
  attachments: Attachment[];
  mentions: string[];
  reply: ReplyPreview | null;
  reactions: ReactionView[];
  system: SystemEvent | null;
  preview: LinkPreview | null;
  forwarded: ForwardInfo | null;
  uploadProgress?: number;
  /** The time the sender's device signed is far from the server's. */
  timeDiffers?: boolean;
}

export interface GroupMemberView {
  userId: string;
  role: GroupRole;
  joinedAt: number;
  /** The server says they're a member, but no device of theirs holds this group's keys. */
  noKeys?: boolean;
  /** A device of theirs holds this group's keys, but the server doesn't list them. */
  notOnRoster?: boolean;
}

/**
 * One row of the conversation list. Everyone on a server can talk to everyone,
 * so a person is a conversation even before the first message is sent.
 */
export interface ConversationView {
  /** `user:<id>` or `group:<id>`. */
  key: string;
  kind: GroupKind;
  groupId: string | null;
  peerId: string | null;
  title: string;
  avatar: AvatarRef | null;
  description: string;
  lastMessage: MessageView | null;
  lastActivityAt: number;
  unread: number;
  mentioned: boolean;
  pinned: boolean;
  muted: boolean;
  /** When a chat muted for a while is heard again (ms), or null. */
  mutedUntil: number | null;
  hidden: boolean;
  /** The group's membership: empty for a DM that has no group yet. */
  members: GroupMemberView[];
  historyVisible: boolean;
  /** Other members' read positions, used for read ticks. */
  readBy: Record<string, number>;
  ownRead: number;
  ready: boolean;
  /** You're no longer in this conversation. Its messages stay until you clear them, or for a while. */
  removed: boolean;
}

export interface Emote {
  id: string;
  name: string;
  animated: boolean;
  zero_width: boolean;
  width: number;
  height: number;
  owner: string;
}

export interface EmoteSet {
  set_id: string;
  set_name: string;
  emotes: Emote[];
}

export interface Preferences {
  pinned: string[];
  hidden: string[];
  /** Chats muted until they're unmuted, by conversation key. */
  muted: string[];
  /** Chats muted for a while: conversation key -> when it ends (ms). */
  mutedUntil?: Record<string, number>;
  sendReadReceipts: boolean;
}

/** Whether a chat is muted now. */
export function isMuted(prefs: Partial<Pick<Preferences, "muted" | "mutedUntil">>, key: string, now = Date.now()): boolean {
  return (prefs.muted ?? []).includes(key) || (prefs.mutedUntil?.[key] ?? 0) > now;
}

export interface DeviceView {
  id: string;
  createdAt: number;
  lastSeenAt: number;
  isCurrent: boolean;
  name: string;
}

export interface SearchResult {
  message: MessageView;
  conversationKey: string;
}

export interface ServerEntry {
  id: string;
  url: string;
  name: string;
  hasIcon: boolean;
  username: string;
  userId: string;
  role: Role;
  /** The server ended this device's session, and why. What's on this device stays until you decide. */
  signedOut: string | null;
}

export type ConnectionState = "connecting" | "syncing" | "online" | "offline";

export interface SafetyCheck {
  emoji: { emoji: string; name: string }[];
  trust: TrustState;
}

export interface Progress {
  loaded: number;
  total: number;
}

/** Everything the core pushes to the UI. */
export type CoreEvent =
  | { type: "connection"; serverId: string; state: ConnectionState }
  | { type: "conversations"; serverId: string }
  | { type: "message"; serverId: string; message: MessageView; isNew: boolean }
  | { type: "message_removed"; serverId: string; groupId: string; id: string }
  | { type: "message_moved"; serverId: string; fromGroupId: string; message: MessageView }
  | { type: "users"; serverId: string }
  | { type: "presence"; serverId: string; userId: string; online: boolean; lastSeenAt: number | null }
  | { type: "typing"; serverId: string; groupId: string; userId: string }
  /** Whether the person is using another of their devices, where notifications go instead. */
  | { type: "activity"; serverId: string; elsewhere: boolean }
  | { type: "read"; serverId: string; groupId: string; userId: string; seq: number }
  | { type: "settings"; serverId: string; info: ServerInfo }
  | { type: "emotes"; serverId: string }
  | { type: "preferences"; serverId: string }
  | { type: "signed_out"; serverId: string; reason: string }
  /** A session that seemed to be over is working after all. */
  | { type: "signed_in"; serverId: string }
  | { type: "security"; serverId: string; userId: string; message: string }
  | { type: "notify"; serverId: string; title: string; body: string; conversationKey: string; groupId: string; messageId: string };
