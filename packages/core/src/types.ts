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
}

export interface ReactionView {
  /** The unicode emoji, or an emote's name. */
  key: string;
  emote?: EmoteRef;
  userIds: string[];
}

export type MessageStatus = "sending" | "sent" | "failed" | "undecryptable" | "unverified";

export interface SystemEvent {
  type:
    | "member_added"
    | "member_removed"
    | "member_left"
    | "member_rejoined"
    | "device_added"
    | "unexpected_join"
    | "identity_changed"
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
  uploadProgress?: number;
}

export interface GroupMemberView {
  userId: string;
  role: GroupRole;
  joinedAt: number;
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
  hidden: boolean;
  /** The group's membership: empty for a DM that has no group yet. */
  members: GroupMemberView[];
  historyVisible: boolean;
  /** Other members' read positions, used for read ticks. */
  readBy: Record<string, number>;
  ownRead: number;
  ready: boolean;
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
  muted: string[];
  sendReadReceipts: boolean;
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
  | { type: "security"; serverId: string; userId: string; message: string }
  | { type: "notify"; serverId: string; title: string; body: string; conversationKey: string; groupId: string; messageId: string };
