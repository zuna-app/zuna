// What other people's devices send arrives as JSON they wrote, and decrypting it
// says nothing about its shape. Everything is checked here, once, before the rest
// of the app sees it. A malformed message must never be able to break the app.

import { plainName } from "./hidden";
import { checkPreview } from "./links";
import type { Attachment, AvatarRef, EarlierMessage, EmoteRef, ForwardInfo, MessageBody, Preferences, Profile, SharedLocation, SystemEvent } from "./types";

/** The longest message text anyone may send, and that clients agree to show. */
export const MAX_TEXT_LENGTH = 100_000;

/** The longest a disappearing message may last, in seconds: a year, as servers allow. */
export const MAX_EXPIRES_IN = 366 * 24 * 60 * 60;

const MAX_ATTACHMENTS = 32;
const MAX_EMOTES = 2000;
const MAX_MENTIONS = 2000;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 1024;
const MAX_MIME_LENGTH = 255;
const MAX_WAVEFORM_LENGTH = 8192;
/** About a 16 KiB file: a tiny blurred picture, shown while the real one loads. */
const MAX_THUMB_LENGTH = 22 << 10;
/** Enough for a file far beyond any server's limit, in 1 MiB chunks. */
const MAX_CHUNKS = 1 << 24;
const MAX_PICTURE_SIDE = 1 << 20;
/** Past this a location says nothing useful, in meters: about the distance around the Earth. */
const MAX_ACCURACY = 40_075_000;

const FILE_ID = /^[0-9a-f]*$/;
const MESSAGE_ID = /^[0-9a-f]{32}$/;
const EMOTE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME = /^[A-Za-z0-9.+_-]+\/[A-Za-z0-9.+_-]+(?:\s*;.*)?$/;
const THUMB = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

type Fields = Record<string, unknown>;

/** A channel's details: what it's called, what it's for and where it goes. */
export interface ChannelDetails {
  name: string;
  topic?: string;
  category?: string;
  /** For a voice channel: how good its audio is, in kbit/s. */
  bitrate?: number;
}

const MAX_CHANNEL_NAME = 100;
const MAX_CHANNEL_TOPIC = 1024;
const MAX_VOICE_BITRATE = 512;
const MIN_VOICE_BITRATE = 8;

const isObject = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);

const isCount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

const absent = (value: unknown): value is null | undefined => value === undefined || value === null;


/** A picture's side, kept only if it makes sense: nothing depends on it but the layout. */
const side = (value: unknown): number | undefined => (typeof value === "number" && value > 0 && value <= MAX_PICTURE_SIDE ? value : undefined);

export function parseEmoteRef(value: unknown): EmoteRef | null {
  if (!isObject(value) || !isString(value.id, 64) || !EMOTE_ID.test(value.id)) return null;
  const emote: EmoteRef = { id: value.id };
  if (value.animated === true) emote.animated = true;
  if (value.zeroWidth === true) emote.zeroWidth = true;
  if (isString(value.owner, MAX_NAME_LENGTH)) emote.owner = value.owner;
  return emote;
}

/**
 * A thumbnail is the one part of a message shown with no click, so it can only
 * be a small picture inside the message itself. Anything else, such as an address
 * that would make the app contact someone's server, is dropped.
 */
function parseThumb(value: unknown): string | undefined {
  return isString(value, MAX_THUMB_LENGTH) && THUMB.test(value) ? value : undefined;
}

function parseAttachment(value: unknown): Attachment | null {
  if (!isObject(value)) return null;
  const { fileId, key, prefix, chunks, name, mime, size } = value;
  if (!isString(fileId, MAX_ID_LENGTH) || !FILE_ID.test(fileId)) return null;
  if (!isString(key, 256) || !BASE64.test(key) || !isString(prefix, 256) || !BASE64.test(prefix)) return null;
  if (!isCount(chunks, MAX_CHUNKS) || !isString(name, MAX_NAME_LENGTH)) return null;
  if (!isString(mime, MAX_MIME_LENGTH) || (mime !== "" && !MIME.test(mime))) return null;
  if (!isCount(size, Number.MAX_SAFE_INTEGER)) return null;
  const attachment: Attachment = { fileId, key, prefix, chunks, name: plainName(name), mime: mime || "application/octet-stream", size };
  const width = side(value.width);
  const height = side(value.height);
  if (width && height) {
    attachment.width = width;
    attachment.height = height;
  }
  const thumb = parseThumb(value.thumb);
  if (thumb) attachment.thumb = thumb;
  if (typeof value.duration === "number" && value.duration >= 0 && Number.isFinite(value.duration)) attachment.duration = value.duration;
  if (value.voice === true) attachment.voice = true;
  // Only a video can be a video message, whatever else says it is one.
  if (value.round === true && attachment.mime.startsWith("video/")) attachment.round = true;
  if (isString(value.waveform, MAX_WAVEFORM_LENGTH) && BASE64.test(value.waveform)) attachment.waveform = value.waveform;
  return attachment;
}

export function parseAvatarRef(value: unknown): AvatarRef | null {
  if (!isObject(value)) return null;
  const { fileId, key, prefix, chunks, mime } = value;
  if (!isString(fileId, MAX_ID_LENGTH) || !FILE_ID.test(fileId) || fileId === "") return null;
  if (!isString(key, 256) || !BASE64.test(key) || !isString(prefix, 256) || !BASE64.test(prefix)) return null;
  if (!isCount(chunks, MAX_CHUNKS) || !isString(mime, MAX_MIME_LENGTH)) return null;
  return { fileId, key, prefix, chunks, mime };
}

function parseEarlier(value: unknown): EarlierMessage | null {
  if (!isObject(value) || !isString(value.id, MAX_ID_LENGTH) || !MESSAGE_ID.test(value.id)) return null;
  if (!isCount(value.epoch, Number.MAX_SAFE_INTEGER) || typeof value.at !== "number" || !Number.isFinite(value.at)) return null;
  const earlier: EarlierMessage = { id: value.id, epoch: value.epoch, at: value.at };
  if (isCount(value.expiresIn, MAX_EXPIRES_IN) && value.expiresIn > 0) earlier.expiresIn = value.expiresIn;
  return earlier;
}

/** A shared place, if it's one on Earth. How far off it may be is dropped if it makes no sense. */
function parseLocation(value: unknown): SharedLocation | null {
  if (!isObject(value)) return null;
  const { lat, lon, accuracy } = value;
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const location: SharedLocation = { lat, lon };
  if (typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= MAX_ACCURACY) location.accuracy = accuracy;
  return location;
}

function parseForwarded(value: unknown): ForwardInfo | null {
  if (!isObject(value)) return null;
  return isString(value.userId, MAX_ID_LENGTH) ? { userId: value.userId } : {};
}

/**
 * A decrypted message body, holding only what's known and in the right shape, or
 * null if it can't be shown. Fields a client has no need to trust, such as a
 * thumbnail or a preview, are dropped instead of failing the whole message.
 */
export function parseMessageBody(value: unknown): MessageBody | null {
  if (!isObject(value)) return null;
  const body: MessageBody = {};
  if (!absent(value.text)) {
    if (!isString(value.text, MAX_TEXT_LENGTH)) return null;
    body.text = value.text;
  }
  if (!absent(value.replyTo)) {
    if (!isString(value.replyTo, MAX_ID_LENGTH)) return null;
    // Looked up on the server to show what's being replied to, so nothing else belongs here.
    if (MESSAGE_ID.test(value.replyTo)) body.replyTo = value.replyTo;
  }
  if (!absent(value.emotes)) {
    if (!isObject(value.emotes)) return null;
    const entries = Object.entries(value.emotes);
    if (entries.length > MAX_EMOTES) return null;
    const emotes: [string, EmoteRef][] = [];
    for (const [name, emote] of entries) {
      const parsed = parseEmoteRef(emote);
      if (!parsed || name.length > MAX_NAME_LENGTH) return null;
      emotes.push([name, parsed]);
    }
    // Defined rather than assigned, so that a name like "__proto__" is only a name.
    body.emotes = Object.fromEntries(emotes);
  }
  if (!absent(value.attachments)) {
    if (!Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENTS) return null;
    const attachments: Attachment[] = [];
    for (const item of value.attachments) {
      const attachment = parseAttachment(item);
      if (!attachment) return null;
      attachments.push(attachment);
    }
    body.attachments = attachments;
  }
  if (!absent(value.mentions)) {
    if (!Array.isArray(value.mentions) || value.mentions.length > MAX_MENTIONS) return null;
    if (!value.mentions.every((id) => isString(id, MAX_ID_LENGTH))) return null;
    body.mentions = value.mentions as string[];
  }
  const preview = checkPreview(value.preview, body.text ?? "");
  if (preview) body.preview = preview;
  if (!absent(value.forwarded)) {
    const forwarded = parseForwarded(value.forwarded);
    if (forwarded) body.forwarded = forwarded;
  }
  if (typeof value.sentAt === "number" && Number.isFinite(value.sentAt)) body.sentAt = value.sentAt;
  if (isCount(value.revision, Number.MAX_SAFE_INTEGER)) body.revision = value.revision;
  const after = parseEarlier(value.after);
  if (after) body.after = after;
  if (isCount(value.expiresIn, MAX_EXPIRES_IN) && value.expiresIn > 0) body.expiresIn = value.expiresIn;
  if (!absent(value.location)) {
    // A location is all such a message says, so one that isn't a place can't be shown.
    const location = parseLocation(value.location);
    if (!location) return null;
    body.location = location;
  }
  return body;
}

const SYSTEM_TYPES = new Set<string>([
  "member_added",
  "member_removed",
  "member_left",
  "member_rejoined",
  "device_added",
  "unexpected_join",
  "identity_changed",
  "identity_rotated",
  "group_created",
  "timer_changed",
]);

/** A notice this device wrote itself, read back from its own database. */
export function parseSystemEvent(value: unknown): SystemEvent | null {
  if (!isObject(value) || typeof value.type !== "string" || !SYSTEM_TYPES.has(value.type)) return null;
  const system: SystemEvent = { type: value.type as SystemEvent["type"] };
  if (typeof value.actorId === "string") system.actorId = value.actorId;
  if (Array.isArray(value.targetIds)) system.targetIds = value.targetIds.filter((id): id is string => typeof id === "string");
  if (isCount(value.seconds, MAX_EXPIRES_IN)) system.seconds = value.seconds;
  return system;
}

/** A person's profile, or null if it isn't one. */
export function parseProfile(value: unknown): Profile | null {
  if (!isObject(value) || !isString(value.displayName, MAX_NAME_LENGTH)) return null;
  const profile: Profile = { displayName: plainName(value.displayName) };
  if (!absent(value.bio)) {
    if (!isString(value.bio, MAX_TEXT_LENGTH)) return null;
    profile.bio = value.bio;
  }
  if (value.avatar === null) profile.avatar = null;
  else if (value.avatar !== undefined) {
    const avatar = parseAvatarRef(value.avatar);
    if (!avatar) return null;
    profile.avatar = avatar;
  }
  return profile;
}

export interface GroupDetails {
  name?: string;
  description?: string;
  avatar?: AvatarRef | null;
  /** Whether people added later get the group's history, as an admin signed it. */
  historyVisible?: boolean;
  /** How long messages sent here last, in seconds, as an admin signed it. 0 or absent: they don't disappear. */
  disappearAfter?: number;
}

/** A group's name, description and picture, or null if they aren't that. */
export function parseGroupDetails(value: unknown): GroupDetails | null {
  if (!isObject(value)) return null;
  const details: GroupDetails = {};
  if (!absent(value.name)) {
    if (!isString(value.name, MAX_NAME_LENGTH)) return null;
    details.name = plainName(value.name);
  }
  if (!absent(value.description)) {
    if (!isString(value.description, MAX_TEXT_LENGTH)) return null;
    details.description = value.description;
  }
  if (value.avatar === null) details.avatar = null;
  else if (value.avatar !== undefined) {
    const avatar = parseAvatarRef(value.avatar);
    if (!avatar) return null;
    details.avatar = avatar;
  }
  if (typeof value.historyVisible === "boolean") details.historyVisible = value.historyVisible;
  if (isCount(value.disappearAfter, MAX_EXPIRES_IN)) details.disappearAfter = value.disappearAfter;
  return details;
}

/** A sound on the soundboard: what it's called, an emoji to show with it, and its file. */
export interface SoundDetails {
  name: string;
  emoji: string;
  durationMs: number;
  file: { fileId: string; key: string; prefix: string; chunks: number };
}

const MAX_SOUND_NAME = 32;
const MAX_SOUND_EMOJI = 32;
const MAX_SOUND_MS = 5_000;

export function parseSoundDetails(value: unknown): SoundDetails | null {
  if (!isObject(value) || !isString(value.name, MAX_SOUND_NAME) || !isCount(value.durationMs, MAX_SOUND_MS) || value.durationMs === 0) return null;
  const name = plainName(value.name).trim();
  if (!name) return null;
  const emoji = absent(value.emoji) ? "" : isString(value.emoji, MAX_SOUND_EMOJI) ? plainName(value.emoji).trim() : null;
  if (emoji === null || !isObject(value.file)) return null;
  const { fileId, key, prefix, chunks } = value.file;
  if (!isString(fileId, MAX_ID_LENGTH) || !MESSAGE_ID.test(fileId)) return null;
  if (!isString(key, 256) || !BASE64.test(key) || !isString(prefix, 256) || !BASE64.test(prefix) || chunks !== 1) return null;
  return { name, emoji, durationMs: value.durationMs, file: { fileId, key, prefix, chunks } };
}

/** Which sound someone played, who says they played it, when, and a value that's only ever used once. */
export function parsePlay(value: unknown): { sound: string; user: string; at: number; nonce: string } | null {
  if (!isObject(value) || !isString(value.sound, MAX_ID_LENGTH) || !MESSAGE_ID.test(value.sound) || !isString(value.user, MAX_ID_LENGTH)) return null;
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || !isString(value.nonce, 64) || value.nonce === "") return null;
  return { sound: value.sound, user: value.user, at: value.at, nonce: value.nonce };
}

/** A channel's details, as someone's device signed them, or null if they make no sense. */
export function parseChannelDetails(value: unknown): ChannelDetails | null {
  if (!isObject(value) || !isString(value.name, MAX_CHANNEL_NAME)) return null;
  const name = plainName(value.name).trim();
  if (!name) return null;
  const details: ChannelDetails = { name };
  if (!absent(value.topic)) {
    if (!isString(value.topic, MAX_CHANNEL_TOPIC)) return null;
    details.topic = value.topic;
  }
  if (!absent(value.category)) {
    if (!isString(value.category, MAX_CHANNEL_NAME)) return null;
    details.category = plainName(value.category).trim();
  }
  if (isCount(value.bitrate, MAX_VOICE_BITRATE) && value.bitrate >= MIN_VOICE_BITRATE) details.bitrate = value.bitrate;
  return details;
}

/** What a reaction says: which emoji or emote it is. */
/** Longer than any emoji or emote's name: a reaction shows as a pill, and a key past this is no reaction. */
const MAX_REACTION_KEY = 100;

export function parseReaction(value: unknown): { key: string; emote?: EmoteRef } | null {
  if (!isObject(value) || !isString(value.key, MAX_REACTION_KEY)) return null;
  // As a name is shown, without what would turn the text around it or hide in it.
  const key = plainName(value.key);
  if (key === "") return null;
  if (absent(value.emote)) return { key };
  const emote = parseEmoteRef(value.emote);
  return emote ? { key, emote } : null;
}

/** How far someone has read. */
export function parseReadState(value: unknown): number | null {
  return isObject(value) && isCount(value.seq, Number.MAX_SAFE_INTEGER) ? value.seq : null;
}

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;

/** Preferences another of this account's devices saved. What isn't right is left as it was. */
export function parsePreferences(value: unknown): Partial<Preferences> {
  if (!isObject(value)) return {};
  const prefs: Partial<Preferences> = {};
  const pinned = strings(value.pinned);
  if (pinned) prefs.pinned = pinned;
  const hidden = strings(value.hidden);
  if (hidden) prefs.hidden = hidden;
  const muted = strings(value.muted);
  if (muted) prefs.muted = muted;
  if (isObject(value.mutedUntil)) {
    prefs.mutedUntil = Object.fromEntries(Object.entries(value.mutedUntil).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  }
  const markedUnread = strings(value.markedUnread);
  if (markedUnread) prefs.markedUnread = markedUnread;
  const mentionsOnly = strings(value.mentionsOnly);
  if (mentionsOnly) prefs.mentionsOnly = mentionsOnly;
  const blocked = strings(value.blocked);
  if (blocked) prefs.blocked = blocked;
  if (typeof value.sendReadReceipts === "boolean") prefs.sendReadReceipts = value.sendReadReceipts;
  // Who this account reported, so its other devices don't offer to report them again.
  const reported = strings(value.reported);
  if (reported) prefs.reported = reported;
  return prefs;
}
