// What other people's devices send arrives as JSON they wrote, and decrypting it
// says nothing about its shape. Everything is checked here, once, before the rest
// of the app sees it. A malformed message must never be able to break the app.

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

const isObject = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);

const isCount = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

const isString = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;

const absent = (value: unknown): value is null | undefined => value === undefined || value === null;

// What changes how the text around it reads, or hides in it. With these, "photo‮gnp.exe"
// reads as if it ended in ".png". Joiners stay: some scripts and emoji need them.
const HIDDEN_CHARACTERS = /[؜​‎‏‪-‮⁠⁦-⁩﻿]/g;

/** A name to show, as what it really says. */
const plainName = (name: string): string => name.replace(HIDDEN_CHARACTERS, "");

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

/** What a reaction says: which emoji or emote it is. */
export function parseReaction(value: unknown): { key: string; emote?: EmoteRef } | null {
  if (!isObject(value) || !isString(value.key, MAX_NAME_LENGTH) || value.key === "") return null;
  if (absent(value.emote)) return { key: value.key };
  const emote = parseEmoteRef(value.emote);
  return emote ? { key: value.key, emote } : null;
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
  if (typeof value.sendReadReceipts === "boolean") prefs.sendReadReceipts = value.sendReadReceipts;
  return prefs;
}
