// TDLib's chats, messages and users as the core's own shapes (types.ts), so that every interface
// shows a Telegram account with the screens it has for a server's. What the engine says is
// untrusted, as what arrives decrypted from a Zuna server is (validate.ts): every field is read
// through the checks here, held to its kind, a length and a range, and anything else is left out.

import type { Attachment, AvatarRef, ConversationView, GroupMemberView, MessageButton, MessageView, ReactionView, ReplyPreview, SystemEvent, UserView } from "../types";
import type { TdObject } from "./engine";
import { toMarkup, type TdEntity } from "./markup";

// --- Checks ---

const MAX_TITLE = 256;
const MAX_NAME = 128;
const MAX_USERNAME = 64;
const MAX_TEXT = 16384;
const MAX_ENTITIES = 1000;
const MAX_URL = 2048;
const MAX_REACTIONS = 64;
const MAX_ROWS = 20;
const MAX_ROW = 12;

export function isObject(value: unknown): value is TdObject {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as TdObject)["@type"] === "string";
}

export function kindOf(value: unknown): string {
  return isObject(value) ? value["@type"] : "";
}

/** A string of at most `max` UTF-16 units, or "". */
export function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** One of TDLib's int53 identifiers, or null. */
export function idOf(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value !== 0 ? value : null;
}

/** A whole number within a range, or `fallback`. */
export function int(value: unknown, min: number, max: number, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export function list(value: unknown, max: number): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function field(value: unknown, name: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[name] : undefined;
}

/** A web address that's http or https, or "". */
function webUrl(value: unknown): string {
  const url = str(value, MAX_URL);
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : "";
}

/** Telegram's formatted text, checked: its entities inside the text, of the kinds there are. */
export function formatted(value: unknown): { text: string; entities: TdEntity[] } {
  const text = str(field(value, "text"), MAX_TEXT);
  const entities: TdEntity[] = [];
  for (const entity of list(field(value, "entities"), MAX_ENTITIES)) {
    const offset = int(field(entity, "offset"), 0, text.length, -1);
    const length = int(field(entity, "length"), 1, text.length, -1);
    const type = field(entity, "type");
    if (offset < 0 || length < 0 || offset + length > text.length || !isObject(type)) continue;
    entities.push({
      offset,
      length,
      type: { "@type": type["@type"], language: str(type.language, 32), url: str(type.url, MAX_URL), user_id: idOf(type.user_id) ?? undefined },
    });
  }
  return { text, entities };
}

// --- Files ---

/** What stands for one of TDLib's files in an attachment or a picture: `tg:<its number>`. */
export const TELEGRAM_FILE = /^tg:(\d{1,10})$/;

/** TDLib's number for a file, checked. */
export function fileNumber(file: unknown): number | null {
  const id = int(field(file, "id"), 1, 2 ** 31 - 1, 0);
  return id || null;
}

function fileSize(file: unknown): number {
  return int(field(file, "size"), 0, 2 ** 52, 0) || int(field(file, "expected_size"), 0, 2 ** 52, 0);
}

/** A small JPEG Telegram sends inline, as a data URL, for showing while the real one loads. */
function minithumbnail(value: unknown): string | undefined {
  const data = str(field(value, "data"), 16384);
  return data && /^[A-Za-z0-9+/=]+$/.test(data) ? `data:image/jpeg;base64,${data}` : undefined;
}

/** A profile picture, as the app's own pictures are referred to, by its small size. */
export function avatarOf(photo: unknown): AvatarRef | null {
  const id = fileNumber(field(photo, "small"));
  return id ? { fileId: `tg:${id}`, key: "", prefix: "", chunks: 0, mime: "image/jpeg" } : null;
}

function bytesOf(base64: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function base64Of(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

/** A voice message's loudness, as Telegram packs it, five bits a bar, as the app's: a byte a bar. */
export function waveformFromTelegram(packed: string): string | undefined {
  const bytes = bytesOf(packed.slice(0, 1024));
  if (!bytes) return undefined;
  const count = Math.floor((bytes.length * 8) / 5);
  if (count === 0) return undefined;
  const bars = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const bit = index * 5;
    const pair = (bytes[bit >> 3] ?? 0) | ((bytes[(bit >> 3) + 1] ?? 0) << 8);
    bars[index] = Math.round((((pair >> (bit & 7)) & 31) * 255) / 31);
  }
  return base64Of(bars);
}

/** The app's waveform, a byte a bar, as Telegram's: a hundred bars of five bits each. */
export function waveformToTelegram(bars: string | undefined): string {
  const values = bars ? bytesOf(bars) : null;
  if (!values || values.length === 0) return "";
  const count = 100;
  const packed = new Uint8Array(Math.ceil((count * 5) / 8) + 1);
  for (let index = 0; index < count; index++) {
    const value = Math.round(((values[Math.floor((index * values.length) / count)] ?? 0) * 31) / 255);
    const bit = index * 5;
    packed[bit >> 3] = (packed[bit >> 3]! | (value << (bit & 7))) & 0xff;
    packed[(bit >> 3) + 1] = (packed[(bit >> 3) + 1]! | (value >> (8 - (bit & 7)))) & 0xff;
  }
  return base64Of(packed.subarray(0, Math.ceil((count * 5) / 8)));
}

/** An attachment for one of TDLib's files, with what else is known of it. */
function attachment(file: unknown, details: Omit<Attachment, "fileId" | "key" | "prefix" | "chunks" | "size">): Attachment | null {
  const id = fileNumber(file);
  if (!id) return null;
  return { fileId: `tg:${id}`, key: "", prefix: "", chunks: 0, size: fileSize(file), ...details };
}

/** The mime type TDLib gives, if it's one, or what it is by default. */
function mimeOf(value: unknown, fallback: string): string {
  const mime = str(value, 128).toLowerCase();
  return /^[a-z]+\/[a-z0-9.+-]+$/.test(mime) ? mime : fallback;
}

/** A file's name as Telegram gives it, with nothing a path could make of it. */
function nameOf(value: unknown, fallback: string): string {
  const name = str(value, 255)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/^\.+/, "");
  return name || fallback;
}

/** The photo's size the app shows: the largest up to 1280 pixels, as Telegram's apps pick it. */
function photoSize(photo: unknown): { file: unknown; width: number; height: number } | null {
  const sizes = list(field(photo, "sizes"), 20)
    .map((size) => ({ file: field(size, "photo"), width: int(field(size, "width"), 1, 20000, 0), height: int(field(size, "height"), 1, 20000, 0) }))
    .filter((size) => size.width > 0 && size.height > 0 && fileNumber(size.file));
  if (sizes.length === 0) return null;
  const fitting = sizes.filter((size) => Math.max(size.width, size.height) <= 1280);
  return (fitting.length > 0 ? fitting : sizes).reduce((best, size) => (size.width * size.height > best.width * best.height ? size : best));
}

/** A message's media as the attachments the app shows, or null where it shows none. */
export function attachmentsOf(content: unknown): Attachment[] | null {
  const kind = kindOf(content);
  const one = (found: Attachment | null) => (found ? [found] : null);
  switch (kind) {
    case "messagePhoto": {
      const photo = field(content, "photo");
      const size = photoSize(photo);
      return size ? one(attachment(size.file, { name: "photo.jpg", mime: "image/jpeg", width: size.width, height: size.height, thumb: minithumbnail(field(photo, "minithumbnail")) })) : null;
    }
    case "messageVideo":
    case "messageAnimation": {
      const isVideo = kind === "messageVideo";
      const video = field(content, isVideo ? "video" : "animation");
      return one(
        attachment(field(video, isVideo ? "video" : "animation"), {
          name: nameOf(field(video, "file_name"), isVideo ? "video.mp4" : "animation.mp4"),
          mime: mimeOf(field(video, "mime_type"), "video/mp4"),
          width: int(field(video, "width"), 0, 20000, 0) || undefined,
          height: int(field(video, "height"), 0, 20000, 0) || undefined,
          duration: int(field(video, "duration"), 0, 2 ** 31, 0) || undefined,
          thumb: minithumbnail(field(video, "minithumbnail")),
        }),
      );
    }
    case "messageDocument": {
      const document = field(content, "document");
      return one(attachment(field(document, "document"), { name: nameOf(field(document, "file_name"), "file"), mime: mimeOf(field(document, "mime_type"), "application/octet-stream"), thumb: minithumbnail(field(document, "minithumbnail")) }));
    }
    case "messageAudio": {
      const audio = field(content, "audio");
      const title = str(field(audio, "title"), 100) || "audio";
      return one(attachment(field(audio, "audio"), { name: nameOf(field(audio, "file_name"), `${title}.mp3`), mime: mimeOf(field(audio, "mime_type"), "audio/mpeg"), duration: int(field(audio, "duration"), 0, 2 ** 31, 0) || undefined }));
    }
    case "messageVoiceNote": {
      const voice = field(content, "voice_note");
      return one(
        attachment(field(voice, "voice"), {
          name: "voice.ogg",
          mime: mimeOf(field(voice, "mime_type"), "audio/ogg"),
          duration: int(field(voice, "duration"), 0, 2 ** 31, 0) || undefined,
          voice: true,
          waveform: waveformFromTelegram(str(field(voice, "waveform"), 1024)),
        }),
      );
    }
    case "messageVideoNote": {
      const note = field(content, "video_note");
      const length = int(field(note, "length"), 0, 2000, 0) || 240;
      return one(attachment(field(note, "video"), { name: "video.mp4", mime: "video/mp4", width: length, height: length, duration: int(field(note, "duration"), 0, 2 ** 31, 0) || undefined, round: true, thumb: minithumbnail(field(note, "minithumbnail")) }));
    }
    case "messageSticker": {
      // A still sticker is a picture. An animated one shows its still thumbnail, until those play.
      const sticker = field(content, "sticker");
      const still = kindOf(field(sticker, "format")) === "stickerFormatWebp";
      const thumbnail = field(sticker, "thumbnail");
      const thumbnailFormat = kindOf(field(thumbnail, "format"));
      if (!still && !["thumbnailFormatWebp", "thumbnailFormatJpeg", "thumbnailFormatPng"].includes(thumbnailFormat)) return null;
      const shown = still ? sticker : thumbnail;
      const mime = still || thumbnailFormat === "thumbnailFormatWebp" ? "image/webp" : thumbnailFormat === "thumbnailFormatPng" ? "image/png" : "image/jpeg";
      return one(
        attachment(still ? field(sticker, "sticker") : field(thumbnail, "file"), {
          name: "sticker.webp",
          mime,
          sticker: true,
          width: int(field(shown, "width"), 1, 2048, 0) || 512,
          height: int(field(shown, "height"), 1, 2048, 0) || 512,
        }),
      );
    }
    default:
      return null;
  }
}

// --- Users ---

/** A sender that isn't a person, as a group's anonymous admin or a channel, by the chat it is. */
export const chatSender = (chatId: number) => `chat:${chatId}`;

/** Who sent something, as a user ID or `chat:<id>`. */
export function senderOf(sender: unknown): string {
  const user = idOf(field(sender, "user_id"));
  if (kindOf(sender) === "messageSenderUser" && user) return String(user);
  const chat = idOf(field(sender, "chat_id"));
  if (kindOf(sender) === "messageSenderChat" && chat) return chatSender(chat);
  return "";
}

export function displayName(user: TdObject): string {
  if (kindOf(user.type) === "userTypeDeleted") return "Deleted Account";
  const name = `${str(user.first_name, MAX_NAME)} ${str(user.last_name, MAX_NAME)}`.trim();
  return name || "Unknown";
}

export function usernameOf(user: TdObject): string {
  const usernames = field(user, "usernames");
  const editable = str(field(usernames, "editable_username"), MAX_USERNAME);
  const active = str(list(field(usernames, "active_usernames"), 1)[0], MAX_USERNAME);
  const name = editable || active;
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : "";
}

/** When someone was last seen, and whether they're online now, as TDLib's status says. */
export function presenceOf(status: unknown, now = Date.now()): { online: boolean; lastSeenAt: number | null; hidesLastSeen: boolean } {
  switch (kindOf(status)) {
    case "userStatusOnline": {
      const expires = int(field(status, "expires"), 0, 2 ** 31, 0) * 1000;
      return { online: expires > now, lastSeenAt: now, hidesLastSeen: false };
    }
    case "userStatusOffline":
      return { online: false, lastSeenAt: int(field(status, "was_online"), 0, 2 ** 31, 0) * 1000 || null, hidesLastSeen: false };
    default:
      // Recently, within a week or a month, or a long time ago: Telegram hides when exactly.
      return { online: false, lastSeenAt: null, hidesLastSeen: true };
  }
}

export function userView(user: TdObject, selfId: number | null, now = Date.now()): UserView | null {
  const id = idOf(user.id);
  if (!id) return null;
  const bot = kindOf(user.type) === "userTypeBot";
  const presence = bot ? { online: false, lastSeenAt: null, hidesLastSeen: true } : presenceOf(user.status, now);
  return {
    id: String(id),
    username: usernameOf(user),
    role: "member",
    displayName: displayName(user),
    bio: "",
    avatar: avatarOf(user.profile_photo),
    ...presence,
    banned: false,
    deleted: kindOf(user.type) === "userTypeDeleted",
    trust: "unverified",
    isSelf: id === selfId,
    bot: bot ? { ownerId: "", listed: true, add: "owner" } : null,
    commands: [],
  };
}

/** A chat that speaks in a group as itself, shown as a sender like a person. */
export function chatSenderView(chatId: number, title: string): UserView {
  return {
    id: chatSender(chatId),
    username: "",
    role: "member",
    displayName: title || "Unknown",
    bio: "",
    avatar: null,
    online: false,
    lastSeenAt: null,
    hidesLastSeen: true,
    banned: false,
    deleted: false,
    trust: "unverified",
    isSelf: false,
    bot: null,
    commands: [],
  };
}

// --- Chats ---

/** Which chats the list has: people and groups, never a channel that broadcasts or a secret chat. */
export function chatKind(chat: TdObject): "dm" | "group" | null {
  const type = chat.type;
  switch (kindOf(type)) {
    case "chatTypePrivate":
      return "dm";
    case "chatTypeBasicGroup":
      return "group";
    case "chatTypeSupergroup":
      return field(type, "is_channel") === true ? null : "group";
    default:
      return null;
  }
}

/** A chat's key, as a conversation's: `user:<id>` for a person, `group:<chat id>` for a group. */
export function chatKey(chat: TdObject): string | null {
  const id = idOf(chat.id);
  if (!id) return null;
  const kind = chatKind(chat);
  if (kind === "dm") {
    const user = idOf(field(chat.type, "user_id"));
    return user ? `user:${user}` : null;
  }
  return kind ? `group:${id}` : null;
}

/** Where a chat sits in a list, or null if it isn't in it. */
export function positionIn(chat: TdObject, listKind: string): { order: bigint; pinned: boolean } | null {
  for (const position of list(chat.positions, 16)) {
    if (kindOf(field(position, "list")) !== listKind) continue;
    const order = str(field(position, "order"), 24);
    if (!/^\d+$/.test(order) || order === "0") return null;
    return { order: BigInt(order), pinned: field(position, "is_pinned") === true };
  }
  return null;
}

/** How long a chat is muted for, in seconds, with its kind's default where it takes that. */
export function muteFor(chat: TdObject, defaults: { private: number; group: number }): number {
  const settings = chat.notification_settings;
  if (field(settings, "use_default_mute_for") === true) return chatKind(chat) === "dm" ? defaults.private : defaults.group;
  return int(field(settings, "mute_for"), 0, 2 ** 31, 0);
}

export interface ChatContext {
  selfId: number | null;
  now: number;
  defaults: { private: number; group: number };
  users: Map<number, TdObject>;
  lastMessage: MessageView | null;
  /** A group's people, as last asked of TDLib. */
  members?: GroupMemberView[];
}

export function conversationView(chat: TdObject, context: ChatContext): ConversationView | null {
  const id = idOf(chat.id);
  const key = chatKey(chat);
  const kind = chatKind(chat);
  // The archive is the app's hidden chats.
  const archived = positionIn(chat, "chatListArchive");
  const position = positionIn(chat, "chatListMain") ?? archived;
  if (!id || !key || !kind || !position) return null;
  const peer = kind === "dm" ? idOf(field(chat.type, "user_id")) : null;
  const peerUser = peer ? context.users.get(peer) : undefined;
  const mute = muteFor(chat, context.defaults);
  const ownRead = idOf(chat.last_read_inbox_message_id) ?? 0;
  const theirRead = idOf(chat.last_read_outbox_message_id) ?? 0;
  const mentions = int(chat.unread_mention_count, 0, 1_000_000, 0);
  const draftDate = int(field(chat.draft_message, "date"), 0, 2 ** 31, 0) * 1000;
  const lastAt = context.lastMessage?.createdAt ?? 0;
  return {
    key,
    kind,
    groupId: String(id),
    peerId: peer ? String(peer) : null,
    // The chat with oneself is Telegram's Saved Messages, which TDLib titles with the account's own name.
    title: peer !== null && peer === context.selfId ? "Saved messages" : str(chat.title, MAX_TITLE) || (peerUser ? displayName(peerUser) : "Unknown"),
    avatar: avatarOf(chat.photo),
    description: "",
    lastMessage: context.lastMessage,
    lastActivityAt: Math.max(lastAt, draftDate),
    unread: int(chat.unread_count, 0, 10_000_000, 0),
    mentioned: mentions > 0,
    unreadMentions: kind === "group" ? mentions : 0,
    pinned: position.pinned,
    muted: mute > 0,
    // Telegram's "forever" is a mute of years.
    mutedUntil: mute > 0 && mute < 366 * 86400 ? context.now + mute * 1000 : null,
    hidden: !!archived && !positionIn(chat, "chatListMain"),
    markedUnread: chat.is_marked_as_unread === true,
    mentionsOnly: false,
    blocked: chat.block_list != null,
    bot: !!peerUser && kindOf(peerUser.type) === "userTypeBot",
    members: context.members ?? [],
    historyVisible: true,
    // Telegram says how far anyone has read what this account sent, not who: in a group, that's everyone's.
    readBy: theirRead ? { [peer ? String(peer) : "*"]: theirRead } : {},
    ownRead,
    ready: true,
    removed: false,
    disappearAfter: int(chat.message_auto_delete_time, 0, 2 ** 31, 0),
    slowMode: 0,
    slowUntil: 0,
  };
}

// --- Messages ---

/** What a message holds, in words, for what Zuna can't show yet. */
const UNSHOWN: Record<string, string> = {
  messagePhoto: "Photo",
  messageVideo: "Video",
  messageAnimation: "GIF",
  messageDocument: "File",
  messageAudio: "Audio",
  messageVoiceNote: "Voice message",
  messageVideoNote: "Video message",
  messagePaidMedia: "Paid media",
  messageVenue: "Place",
  messagePoll: "Poll",
  messageDice: "Dice",
  messageGame: "Game",
  messageInvoice: "Payment",
  messageGift: "Gift",
  messageStory: "Story",
  messageChecklist: "Checklist",
};

export interface MessageContext {
  selfId: number | null;
  now: number;
  /** A message already seen here, for the preview of a reply to it. */
  find: (chatId: number, messageId: number) => TdObject | undefined;
  /** Whose name a sender ID has, for lines about people. */
  nameOf: (senderId: string) => string;
}

/** The words a message's content shows, and whether it has something Zuna can't show yet. */
function contentText(content: unknown): { text: string; unshown: string | null; attachments: Attachment[] } {
  const kind = kindOf(content);
  if (kind === "messageText") return { text: toMarkup(formatted(field(content, "text"))), unshown: null, attachments: [] };
  const caption = toMarkup(formatted(field(content, "caption")));
  // Seen once, it's never downloaded here: Telegram's own app shows it.
  const once = kindOf(field(content, "self_destruct_type")) !== "" || field(content, "is_secret") === true;
  const media = once ? null : attachmentsOf(content);
  if (media) return { text: kind === "messageSticker" ? "" : caption, unshown: null, attachments: media };
  if (kind === "messageSticker") return { text: str(field(field(content, "sticker"), "emoji"), 16) || "Sticker", unshown: null, attachments: [] };
  if (kind === "messageContact") {
    const contact = field(content, "contact");
    const name = `${str(field(contact, "first_name"), MAX_NAME)} ${str(field(contact, "last_name"), MAX_NAME)}`.trim();
    return { text: `Contact: ${name || "someone"}`, unshown: null, attachments: [] };
  }
  if (kind === "messageLocation") return { text: "", unshown: null, attachments: [] };
  const what = UNSHOWN[kind];
  if (what) return { text: caption, unshown: once ? `${what}, to be seen once` : what, attachments: [] };
  return { text: "", unshown: "A message Zuna can't show", attachments: [] };
}

/** A line about a group, as the app's own system lines, or words where it has none. */
function serviceLine(content: unknown, senderId: string, context: MessageContext): { system: SystemEvent | null; text: string } | null {
  const kind = kindOf(content);
  const actorId = senderId || undefined;
  const ids = (value: unknown) => list(value, 200).map(idOf).filter((id): id is number => !!id).map(String);
  switch (kind) {
    case "messageChatAddMembers":
      return { system: { type: "member_added", actorId, targetIds: ids(field(content, "member_user_ids")) }, text: "" };
    case "messageChatJoinByLink":
    case "messageChatJoinByRequest":
      return { system: { type: "member_added", actorId, targetIds: senderId ? [senderId] : [] }, text: "" };
    case "messageChatDeleteMember": {
      const user = String(idOf(field(content, "user_id")) ?? "");
      return { system: { type: user === senderId ? "member_left" : "member_removed", actorId, targetIds: user ? [user] : [] }, text: "" };
    }
    case "messageBasicGroupChatCreate":
    case "messageSupergroupChatCreate":
      return { system: { type: "group_created", actorId }, text: "" };
    case "messageChatSetMessageAutoDeleteTime":
      return { system: { type: "timer_changed", actorId, seconds: int(field(content, "message_auto_delete_time"), 0, 2 ** 31, 0) }, text: "" };
    case "messageChatChangeTitle":
      return { system: null, text: `_${context.nameOf(senderId)} named the group “${str(field(content, "title"), MAX_TITLE)}”_` };
    case "messageChatChangePhoto":
      return { system: null, text: `_${context.nameOf(senderId)} changed the group's picture_` };
    case "messageChatDeletePhoto":
      return { system: null, text: `_${context.nameOf(senderId)} removed the group's picture_` };
    case "messagePinMessage":
      return { system: null, text: `_${context.nameOf(senderId)} pinned a message_` };
    case "messageScreenshotTaken":
      return { system: null, text: `_${context.nameOf(senderId)} took a screenshot_` };
    case "messageContactRegistered":
      return { system: null, text: `_${context.nameOf(senderId)} joined Telegram_` };
    case "messageChatUpgradeTo":
    case "messageChatUpgradeFrom":
      return { system: null, text: "_The group was upgraded_" };
    case "messageCall": {
      const missed = kindOf(field(content, "discard_reason")) === "callDiscardReasonMissed";
      const video = field(content, "is_video") === true;
      return { system: null, text: `_${missed ? "Missed" : video ? "Video" : "Voice"} ${missed && video ? "video " : ""}call, in Telegram's app_` };
    }
    default:
      return kind.startsWith("messageChat") || kind.startsWith("messageSupergroup") || kind.startsWith("messageBasicGroup") || kind === "messageCustomServiceAction"
        ? { system: null, text: "_Something changed in the group_" }
        : null;
  }
}

function reactions(message: TdObject, selfId: number | null): ReactionView[] {
  const views: ReactionView[] = [];
  const self = selfId ? String(selfId) : "";
  for (const reaction of list(field(field(message.interaction_info, "reactions"), "reactions"), MAX_REACTIONS)) {
    if (kindOf(field(reaction, "type")) !== "reactionTypeEmoji") continue;
    const key = str(field(field(reaction, "type"), "emoji"), 16);
    if (!key) continue;
    const total = int(field(reaction, "total_count"), 0, 100_000_000, 0);
    const userIds = list(field(reaction, "recent_sender_ids"), 10).map(senderOf).filter(Boolean);
    if (field(reaction, "is_chosen") === true && self && !userIds.includes(self)) userIds.unshift(self);
    // Telegram names a few of those who reacted: the rest count, without names.
    for (let index = 0; userIds.length < Math.min(total, 500); index++) userIds.push(`?${index}`);
    if (userIds.length > 0) views.push({ key, userIds });
  }
  return views;
}

function buttons(message: TdObject): MessageButton[][] {
  const markup = message.reply_markup;
  if (kindOf(markup) !== "replyMarkupInlineKeyboard") return [];
  const rows: MessageButton[][] = [];
  for (const row of list(field(markup, "rows"), MAX_ROWS)) {
    const out: MessageButton[] = [];
    for (const button of list(row, MAX_ROW)) {
      const text = str(field(button, "text"), 128);
      const type = field(button, "type");
      if (!text) continue;
      if (kindOf(type) === "inlineKeyboardButtonTypeUrl") {
        const url = webUrl(field(type, "url"));
        if (url) out.push({ text, url });
      } else if (kindOf(type) === "inlineKeyboardButtonTypeCallback") {
        const data = str(field(type, "data"), 128);
        if (/^[A-Za-z0-9+/=]*$/.test(data)) out.push({ text, data });
      }
    }
    if (out.length > 0) rows.push(out);
  }
  return rows;
}

function replyPreview(message: TdObject, context: MessageContext): ReplyPreview | null {
  const reply = message.reply_to;
  if (kindOf(reply) !== "messageReplyToMessage") return null;
  const target = idOf(field(reply, "message_id"));
  const chatId = idOf(field(reply, "chat_id")) ?? idOf(message.chat_id);
  if (!target || !chatId) return null;
  const original = context.find(chatId, target);
  if (!original) return { id: String(target), senderId: "", text: "", hasAttachment: false, deleted: false };
  const content = contentText(original.content);
  return {
    id: String(target),
    senderId: senderOf(original.sender_id),
    text: content.text || content.unshown || "",
    hasAttachment: content.unshown !== null || content.attachments.length > 0,
    deleted: false,
  };
}

export function messageView(message: TdObject, context: MessageContext): MessageView | null {
  const id = idOf(message.id);
  const chatId = idOf(message.chat_id);
  if (!id || !chatId) return null;
  const senderId = senderOf(message.sender_id);
  const sending = kindOf(message.sending_state);
  const createdAt = int(message.date, 0, 2 ** 31, 0) * 1000;
  const edited = int(message.edit_date, 0, 2 ** 31, 0) * 1000;
  const service = serviceLine(message.content, senderId, context);
  const content = service ? { text: service.text, unshown: null, attachments: [] } : contentText(message.content);
  const unshownLine = content.unshown ? `_${content.unshown}, which Zuna can't show yet. It's in Telegram's app._` : "";
  const location = field(message.content, "location");
  const latitude = field(location, "latitude");
  const longitude = field(location, "longitude");
  const preview = message.link_preview;
  const previewUrl = webUrl(field(preview, "url"));
  const autoDelete = typeof message.auto_delete_in === "number" && message.auto_delete_in > 0 ? message.auto_delete_in : 0;
  const forward = field(field(message.forward_info, "origin"), "@type");
  const forwardUser = forward === "messageOriginUser" ? idOf(field(field(message.forward_info, "origin"), "sender_user_id")) : null;
  const forwardChat = forward === "messageOriginChat" || forward === "messageOriginChannel" ? idOf(field(field(message.forward_info, "origin"), forward === "messageOriginChat" ? "sender_chat_id" : "chat_id")) : null;
  return {
    id: String(id),
    groupId: String(chatId),
    seq: id,
    senderId,
    createdAt,
    editedAt: edited || null,
    deletedAt: null,
    pinnedAt: message.is_pinned === true ? createdAt : null,
    pinnedBy: null,
    status: sending === "messageSendingStatePending" ? "sending" : sending === "messageSendingStateFailed" ? "failed" : "sent",
    text: [content.text, unshownLine].filter(Boolean).join("\n"),
    emotes: {},
    attachments: content.attachments,
    mentions: [],
    reply: replyPreview(message, context),
    reactions: reactions(message, context.selfId),
    system: service?.system ?? null,
    preview: previewUrl
      ? { url: previewUrl, title: str(field(preview, "title"), 300) || undefined, description: str(field(field(preview, "description"), "text"), 600) || undefined, siteName: str(field(preview, "site_name"), 100) || undefined }
      : null,
    forwarded: forward ? (forwardUser ? { userId: String(forwardUser) } : forwardChat ? { userId: chatSender(forwardChat) } : {}) : null,
    location:
      typeof latitude === "number" && typeof longitude === "number" && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
        ? { lat: latitude, lon: longitude }
        : null,
    buttons: buttons(message),
    expiresAt: autoDelete ? context.now + Math.round(autoDelete * 1000) : null,
  };
}
