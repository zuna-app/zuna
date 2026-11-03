// Shapes shared between the client core and the UI.

export type Role = "owner" | "admin" | "member";
export type GroupRole = "admin" | "member";
export type GroupKind = "dm" | "group" | "channel";
export type ChannelType = "text" | "voice";

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
  /** Whether this server takes requests signed by a device's key. Absent on one that doesn't. */
  request_proofs?: number;
  /** Whether this server removes disappearing messages when they're due. Absent on one that doesn't. */
  disappearing?: number;
  /** Whether this server has channels. Absent on one that doesn't. */
  channels?: number;
  /** Whether this server has a media server, without which voice channels can't be joined. */
  voice?: number;
  /** Whether direct messages and groups can have calls there. Absent on one that can't. */
  calls?: number;
  /** What its admins say about sharing a screen. Absent on one from before it had a say, and for anyone not signed in. */
  screen_share?: ScreenRules;
}

/**
 * What a server's admins say about sharing a screen. Who may share, with sound, and how
 * many at once hold whatever an app does. The rest is about media the server can't see,
 * so apps keep to it themselves.
 */
export interface ScreenRules {
  who: "everyone" | "admins" | "nobody";
  sound: boolean;
  /** Server admins aren't held to the limits, though sharing being off still goes for them. */
  admins_exempt: boolean;
  /** How many may share at once, or 0 for no limit. */
  max_per_channel: number;
  max_per_server: number;
  /** The most a share may use, or 0 for no limit. */
  max_height: number;
  max_fps: number;
  max_kbps: number;
  max_sound_kbps: number;
  /** What a share uses until someone chooses otherwise. A height of 0 is the screen's own. */
  default_height: number;
  default_fps: number;
  default_kbps: number;
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
  /** The relay's handle for this device's VoIP token, which calls ring through as phone calls, if it has one. */
  callHandle?: string;
  /** Seals each push, so the relay sees only that one arrived. */
  key: Uint8Array;
  /** The app's own ID for this registration, so it knows which server a push is from. */
  registration: string;
  /**
   * Tell the server which chats are muted, so it skips them, for an app that
   * can't hide notifications itself. Otherwise it's pushed for everything,
   * channels too, and hides what it shouldn't show.
   */
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
  /** Which edit this is, signed with the rest: higher for each later one, and absent before any. */
  revision?: number;
  /** The message the sender's device sent before this one here, signed with the rest, so a recipient can tell if the server held that one back. */
  after?: EarlierMessage;
  /** How long after it's sent the message disappears, in seconds, signed with the rest. */
  expiresIn?: number;
  /** A place the sender shared, from their device. */
  location?: SharedLocation;
}

/**
 * Where someone's device said they were when they shared it. It travels inside
 * the message, and nothing about it loads a map: only opening it elsewhere does.
 */
export interface SharedLocation {
  /** Degrees north, from -90 to 90. */
  lat: number;
  /** Degrees east, from -180 to 180. */
  lon: number;
  /** How far off it may be, in meters, as the device said. */
  accuracy?: number;
}

/** How long a chat's messages can be set to last, in seconds: an hour, a day, a week and a month. */
export const DISAPPEARING_TIMES: readonly number[] = [3600, 86400, 7 * 86400, 30 * 86400];

/** A message a device sent: its ID, its epoch, and when, by that device's clock (ms). */
export interface EarlierMessage {
  id: string;
  epoch: number;
  at: number;
  /** How long that one lasts, in seconds, if it disappears, so a recipient knows not to look for one that's gone. */
  expiresIn?: number;
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
    | "group_created"
    | "timer_changed";
  actorId?: string;
  targetIds?: string[];
  /** For "timer_changed": how long messages now last, in seconds, or 0 for as long as they're kept. */
  seconds?: number;
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
  location: SharedLocation | null;
  uploadProgress?: number;
  /** The time the sender's device signed is far from the server's. */
  timeDiffers?: boolean;
  /** When it disappears from this device (ms), or null if it doesn't. */
  expiresAt: number | null;
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
  /** Whether any of those mention you or reply to you. */
  mentioned: boolean;
  /** How many unread messages in a group mention you or reply to you, and haven't been jumped to. Always 0 in a direct message. */
  unreadMentions: number;
  pinned: boolean;
  muted: boolean;
  /** When a chat muted for a while is heard again (ms), or null. */
  mutedUntil: number | null;
  hidden: boolean;
  /** Marked as unread by hand, as in Telegram, until it's opened. */
  markedUnread: boolean;
  /** Notifies only about messages that mention you or reply to you, though its unread messages still count. */
  mentionsOnly: boolean;
  /** A direct message with someone you blocked. */
  blocked: boolean;
  /** The group's membership: empty for a DM that has no group yet. */
  members: GroupMemberView[];
  historyVisible: boolean;
  /** Other members' read positions, used for read ticks. */
  readBy: Record<string, number>;
  ownRead: number;
  ready: boolean;
  /** You're no longer in this conversation. Its messages stay until you clear them, or for a while. */
  removed: boolean;
  /** How long messages sent here now last, in seconds, or 0 if they don't disappear. */
  disappearAfter: number;
}

/**
 * A channel anyone on the server can see and join. Its details are sealed with the
 * community key, so the server can't read them. Once joined, it's a conversation.
 */
export interface ChannelView {
  id: string;
  type: ChannelType;
  /** `group:<id>`, as a conversation's key. */
  key: string;
  /** What it's called, or empty if what the server gave couldn't be read or checked. */
  name: string;
  topic: string;
  /** The heading it goes under, or empty for the usual one. */
  category: string;
  /** For a voice channel: how good its audio is, in kbit/s, or 0 for the usual. */
  bitrate: number;
  position: number;
  /** For a voice channel: how many people fit, or 0 for no limit. */
  userLimit: number;
  /** For a voice channel: how many may share a screen at once, 0 for what the server's rules say, or -1 for nobody. */
  screenLimit: number;
  /** The details couldn't be read or checked, so they aren't shown. */
  unreadable: boolean;
  /** Null until this device has joined it, which it does by itself. */
  conversation: ConversationView | null;
}

/** Someone's device in a voice channel or a call, as it says. */
export interface VoiceMember {
  /** The voice channel, or the conversation whose call it is. */
  channelId: string;
  userId: string;
  deviceId: string;
  muted: boolean;
  deafened: boolean;
  /** Muted by an admin, which LiveKit itself enforces. */
  serverMuted: boolean;
  camera: boolean;
  screen: boolean;
  /** When they came in (ms). */
  since: number;
}

/** What this device is doing in a voice channel, for everyone to see, or in a call, for the conversation to see. */
export interface VoiceUpdate {
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
}

/**
 * A call in a direct message or a group, from when someone comes into it until the last one
 * leaves. Who's in it are the voice members with its conversation's group ID.
 */
export interface CallView {
  groupId: string;
  startedBy: string;
  /** When it started (ms). */
  startedAt: number;
  /** People whose devices it's ringing, until they answer or decline, or a while passes. */
  ringing: string[];
  /** People who declined it. */
  declined: string[];
}

/** How to reach a voice channel's room. The token only lets this device in: media keys come from MLS. */
export interface VoiceAccess {
  url: string;
  token: string;
  identity: string;
  /** An admin has muted this person, so the microphone won't be let through. */
  serverMuted: boolean;
}

/** Being let share a screen, which holds a place until it's given back. */
export interface ScreenAccess {
  /** The computer's sound may go with it. */
  sound: boolean;
  /** How a native process reaches the room, as a participant that can do nothing else. */
  native: { url: string; token: string; identity: string } | null;
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
  /** Chats marked as unread by hand, by conversation key. */
  markedUnread?: string[];
  /** Chats that notify only about messages that mention you or reply to you, by conversation key. */
  mentionsOnly?: string[];
  /** People whose messages are kept out of sight, unread counts and notifications, by user ID. Nobody else learns of it. */
  blocked?: string[];
  sendReadReceipts: boolean;
}

/** Whether a chat is muted now. */
export function isMuted(prefs: Partial<Pick<Preferences, "muted" | "mutedUntil">>, key: string, now = Date.now()): boolean {
  return (prefs.muted ?? []).includes(key) || (prefs.mutedUntil?.[key] ?? 0) > now;
}

/** Whether a chat notifies only about messages that mention you or reply to you: it's muted, or set to mentions only. */
export function onlyMentionsNotify(prefs: Partial<Pick<Preferences, "muted" | "mutedUntil" | "mentionsOnly">>, key: string, now = Date.now()): boolean {
  return isMuted(prefs, key, now) || (prefs.mentionsOnly ?? []).includes(key);
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

/** What a chat's details list on their own, as Telegram does: its photos, files, links and so on. */
export type MediaKind = "photo" | "video" | "file" | "audio" | "voice" | "link";

/** How many of each kind a chat holds. A message with links counts once, however many it has. */
export type MediaCounts = Record<MediaKind, number>;

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
  /** What those emoji cover, to hand back to `markVerified` if they match. */
  covers: string;
}

export interface Progress {
  loaded: number;
  total: number;
}

/** Everything the core pushes to the UI. */
export type CoreEvent =
  | { type: "connection"; serverId: string; state: ConnectionState }
  | { type: "conversations"; serverId: string }
  /** The channels changed. */
  | { type: "channels"; serverId: string }
  /** Someone's device came, went or changed in a voice channel. */
  | { type: "voice"; serverId: string; channelId: string; userId: string; deviceId: string; member: VoiceMember | null }
  /** Who's in the voice channel this device is in changed, so its media key did too. */
  | { type: "voice_key"; serverId: string; channelId: string }
  /** This device has been taken out of a voice channel. */
  | { type: "voice_ended"; serverId: string; channelId: string; reason: string }
  /** This device's screen share has been stopped: "stopped" by an admin, or by a change to the "rules". */
  | { type: "screen_ended"; serverId: string; channelId: string; reason: string }
  /** A call in a conversation started, changed whom it's ringing, or ended (null). */
  | { type: "call"; serverId: string; groupId: string; call: CallView | null }
  /** The calls going on were caught up on, so ask again for them and who's in them. */
  | { type: "calls"; serverId: string }
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
