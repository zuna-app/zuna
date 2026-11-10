// A notification for a message a phone heard about through a push, worded as
// a connected session would word it (maybeNotify in session.ts). It runs in the
// iOS app's Notification Service Extension, which has too little memory for a
// whole session and runs beside the app: it reads only the rows it needs from
// the local databases, never writes, and fetches the one message. The
// databases stay open for the next push, as the provider keeps them. A call
// ringing is worded from what's on the device alone, with nothing to fetch.

import * as wasm from "@zuna/crypto";
import { Api, decode, type ApiChannel } from "./api";
import { openChannelDetails } from "./channels";
import { INDEX_DB, decodeAccount, label, serverDbName, serverKeyFor } from "./client";
import { checkEnvelope, namesItsSender } from "./crypto";
import type { DbProvider } from "./db";
import { concat, fromBase64, fromUtf8, toBase64 } from "./encoding";
import { notificationText, previewText } from "./notify";
import { couldBeSent, sealedRows } from "./sendable";
import { isMuted, onlyMentionsNotify, type AvatarRef, type Preferences, type Profile } from "./types";
import { parseChannelDetails, parseMessageBody } from "./validate";

export interface PushPreview {
  serverId: string;
  /** The chat to open, when the device knows it. */
  conversationKey: string | null;
  title: string;
  body: string;
  /** False when the message can't be read yet, such as in an epoch this device hasn't seen: the text is then generic. */
  decrypted: boolean;
  /** The chat is muted or notifies only about mentions, and the message doesn't mention you or reply to you. */
  muted: boolean;
  /** Nothing to show: your own message, one deleted since, or one from someone you blocked. */
  hidden: boolean;
  /** For a notification laid out as a conversation: who wrote it, with their picture when asked for. */
  sender?: { id: string; name: string; picture?: string };
  /** The group it's in, with the group's picture when asked for. */
  group?: { name: string; picture?: string };
  /** The message alone, without the sender's name in front. */
  text?: string;
  /** When the server took the message, by its clock (ms), if it could be fetched: a chat read after that has read it. */
  sentAt?: number;
}

/** Pictures are small; anything bigger isn't worth a notification extension's time. */
const MAX_PICTURE_CHUNKS = 4;

interface StoredUser {
  username: string;
  profile: Profile;
  devices: { id: string; signatureKey: string }[];
  trust?: string;
}

interface StoredGroup {
  id: string;
  kind: "dm" | "group" | "channel";
  peerId: string | null;
  meta: { name?: string; avatar?: AvatarRef | null };
}

/**
 * A server as this device keeps it, opened without a session: its account, its database, and
 * reading what the session sealed there, for a phone's previews.
 */
async function openServer(options: { db: DbProvider; deviceKey: Uint8Array }, serverId: string) {
  const key = serverKeyFor(options.deviceKey, serverId);
  const index = await options.db.open(INDEX_DB);
  const server = index.get<{ account: Uint8Array; name: string }>("SELECT account, name FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new Error("This device isn't signed in to that server.");
  const account = decodeAccount(fromUtf8(wasm.aeadOpen(key, server.account, label("account"))));
  const db = await options.db.open(serverDbName(serverId));
  // As the session seals it: naming its table and row.
  const read = <T>(name: string, row: string, data: Uint8Array): T => JSON.parse(fromUtf8(wasm.aeadOpen(key, data, label(`${name}|${row}`))));
  const user = (id: string | null) => {
    const row = id ? db.get<{ data: Uint8Array }>("SELECT data FROM users WHERE id = ?", [id]) : undefined;
    return row ? read<StoredUser>("user", id!, row.data) : null;
  };
  const nameOf = (stored: StoredUser | null) => stored?.profile.displayName || stored?.username || "Someone";
  return { key, server, account, db, read, user, nameOf };
}

export async function previewPush(
  options: { db: DbProvider; deviceKey: Uint8Array },
  serverId: string,
  groupId: string,
  messageId: string,
  /** Also download and decrypt the sender's and the group's pictures, as base64. */
  pictures = false,
): Promise<PushPreview> {
  const { key, server, account, db, read, user, nameOf } = await openServer(options, serverId);

  const groupRow = db.get<{ data: Uint8Array }>("SELECT data FROM groups WHERE id = ?", [groupId]);
  const group = groupRow ? read<StoredGroup>("group", groupId, groupRow.data) : null;
  const conversationKey = group ? (group.kind === "dm" ? `user:${group.peerId}` : `group:${group.id}`) : null;
  // A channel is called what its details say, believed only if a device of someone here signed them, as the session does.
  const channelName = (): string => {
    const row = db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", ["channels"]);
    const channel = row ? read<ApiChannel[]>("kv", "channels", row.v).find((item) => item.id === groupId) : undefined;
    const signed = channel ? openChannelDetails(account.core.communityKey, groupId, decode(channel.details)) : null;
    const device = signed && user(signed.signer.userId)?.devices.find((item) => item.id === signed.signer.deviceId);
    const name = device && signed.signedBy(fromBase64(device.signatureKey)) ? parseChannelDetails(signed.details)?.name : undefined;
    return `#${name ?? "channel"}`;
  };
  const groupName = group?.kind === "channel" ? channelName() : group?.meta.name || "Group";
  let sentAt: number | undefined;
  const preview = (fields: Partial<PushPreview>): PushPreview => ({
    serverId,
    conversationKey,
    // Without the message, at least the chat; without the chat, the server.
    title: group ? (group.kind === "dm" ? nameOf(user(group.peerId)) : groupName) : server.name,
    body: "New message",
    decrypted: false,
    muted: false,
    hidden: false,
    sentAt,
    ...fields,
  });

  const api = new Api(account.serverUrl);
  api.token = account.token;
  const message = await api.message(groupId, messageId).catch(() => null);
  if (!message) return preview({});
  if (Number.isSafeInteger(message.created_at)) sentAt = message.created_at;
  if (message.deleted_at || !message.envelope) return preview({ hidden: true });

  const epochRow = db.get<{ key: Uint8Array }>("SELECT key FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, message.epoch]);
  if (!group || !epochRow) return preview({});
  // Who sent it is inside, under their device's signature: the server isn't told.
  const epochKey = wasm.aeadOpen(key, epochRow.key, label(`epoch|${groupId}:${message.epoch}`));
  const checked = checkEnvelope<unknown>(epochKey, "message", groupId, message.id, message.epoch, decode(message.envelope), (signer) => {
    const device = user(signer.userId)?.devices.find((item) => item.id === signer.deviceId);
    return device && fromBase64(device.signatureKey);
  });
  if (checked.state !== "signed" || !namesItsSender(checked.value, checked.signer.userId, checked.signer.deviceId)) return preview({});
  const { userId: senderUser, deviceId: senderDevice } = checked.signer;
  if (senderUser === account.userId) return preview({ hidden: true });
  const sender = user(senderUser);
  if (!sender) return preview({});
  // What the app wouldn't show as theirs isn't worded as theirs here either: a message
  // from a device in an epoch after it left, or after its epoch ended (couldBeSent in
  // session.ts), or from someone whose key changed in a way that doesn't follow.
  // Sealed as the session seals them. One that doesn't open counts the most careful way.
  const value = (name: string, row: string, data: Uint8Array | undefined, careful: number): number | null => {
    if (!data) return null;
    try {
      return read<number>(name, row, data);
    } catch {
      return careful;
    }
  };
  const { departure, arrival, joined, epochStart } = sealedRows;
  const sendable = couldBeSent(
    {
      left: () => value(departure.name, departure.row(groupId, senderUser, senderDevice), db.get<{ epoch: Uint8Array }>("SELECT epoch FROM device_departures WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, senderUser, senderDevice])?.epoch, departure.careful),
      joined: () => value(joined.name, joined.row(groupId), db.get<{ epoch: Uint8Array }>("SELECT epoch FROM joined_epochs WHERE group_id = ?", [groupId])?.epoch, joined.careful),
      arrived: () => value(arrival.name, arrival.row(groupId, senderUser, senderDevice), db.get<{ epoch: Uint8Array }>("SELECT epoch FROM device_arrivals WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, senderUser, senderDevice])?.epoch, arrival.careful),
      nextStart: () => value(epochStart.name, epochStart.row(groupId, message.epoch + 1), db.get<{ seq: Uint8Array }>("SELECT seq FROM epoch_starts WHERE group_id = ? AND epoch = ?", [groupId, message.epoch + 1])?.seq, epochStart.careful),
    },
    message,
  );
  if (!sendable || sender.trust === "changed") return preview({});
  const body = parseMessageBody(checked.value);
  if (!body) return preview({});

  const prefsRow = db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", ["prefs"]);
  const prefs = prefsRow ? read<Partial<Preferences>>("kv", "prefs", prefsRow.v) : {};
  if (prefs.blocked?.includes(senderUser)) return preview({ hidden: true });
  // A reply counts if this device holds the message replied to, as for the session's "@".
  const repliedTo = body.replyTo ? db.get<{ sender_user: string }>("SELECT sender_user FROM messages WHERE group_id = ? AND id = ?", [groupId, body.replyTo]) : undefined;
  const mentioned = (body.mentions ?? []).includes(account.userId) || repliedTo?.sender_user === account.userId;
  const content = { text: body.text ?? "", attachments: body.attachments ?? [], location: body.location };
  const picture = async (avatar: AvatarRef | null | undefined) => {
    if (!pictures || !avatar || avatar.chunks > MAX_PICTURE_CHUNKS) return undefined;
    try {
      const key = fromBase64(avatar.key);
      const prefix = fromBase64(avatar.prefix);
      const parts: Uint8Array[] = [];
      for (let index = 0; index < avatar.chunks; index++) {
        const sealed = await api.downloadChunk(avatar.fileId, index);
        parts.push(wasm.streamOpen(key, prefix, index, index === avatar.chunks - 1, sealed));
      }
      return toBase64(concat(...parts));
    } catch {
      return undefined;
    }
  };
  return preview({
    ...notificationText(group.kind, groupName, nameOf(sender), content),
    decrypted: true,
    // Everything said in a channel isn't for everyone in it: only what's said to them.
    muted: !mentioned && (group.kind === "channel" || onlyMentionsNotify(prefs, conversationKey!)),
    sender: { id: senderUser, name: nameOf(sender), picture: await picture(sender.profile.avatar) },
    group: group.kind === "dm" ? undefined : { name: groupName, picture: group.kind === "group" ? await picture(group.meta.avatar) : undefined },
    text: previewText(content),
  });
}

/**
 * The chats the server still counts this phone as showing a notification for: it was pushed
 * one, or left to show one itself, and none of the person's devices has read the chat since.
 * A phone asks whenever something wakes it, and clears what it shows for any other chat. iOS
 * hands a silent push over when it likes, or never, as to an app its person closed, so the
 * push that says a chat was read can't be all that clears its notifications. Like a preview,
 * it needs no session and writes nothing.
 */
export async function notifiedChats(options: { db: DbProvider; deviceKey: Uint8Array }, serverId: string): Promise<string[]> {
  const { account } = await openServer(options, serverId);
  const api = new Api(account.serverUrl);
  api.token = account.token;
  const groups: unknown = await api.pushNotified();
  // Anything else would have the phone clear everything it shows.
  if (!Array.isArray(groups) || groups.some((id) => typeof id !== "string")) throw new Error("The server didn't say which chats this device was notified about.");
  return groups as string[];
}

/** What a phone shows for a call it was woken to ring for. */
export interface CallPreview {
  serverId: string;
  /** The chat it's in, when the device knows it. */
  conversationKey: string | null;
  /** Who's calling in a direct message, or the group's name. */
  title: string;
  body: string;
  /** The conversation is muted, so it rings without a sound. */
  muted: boolean;
  /** Nothing to ring for: someone blocked, or a conversation this device doesn't have. */
  hidden: boolean;
}

/** A call ringing this phone, as the app would ring it: from the conversation and its caller, with nothing fetched. */
export async function previewCall(options: { db: DbProvider; deviceKey: Uint8Array }, serverId: string, groupId: string, callerId: string): Promise<CallPreview> {
  const { server, account, db, read, user, nameOf } = await openServer(options, serverId);
  const groupRow = db.get<{ data: Uint8Array }>("SELECT data FROM groups WHERE id = ?", [groupId]);
  const group = groupRow ? read<StoredGroup & { removedAt?: number | null }>("group", groupId, groupRow.data) : null;
  const prefsRow = db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", ["prefs"]);
  const prefs = prefsRow ? read<Partial<Preferences>>("kv", "prefs", prefsRow.v) : {};
  if (!group || group.kind === "channel" || group.removedAt || callerId === account.userId || prefs.blocked?.includes(callerId)) {
    return { serverId, conversationKey: null, title: server.name, body: "Incoming call", muted: false, hidden: true };
  }
  const conversationKey = group.kind === "dm" ? `user:${group.peerId}` : `group:${group.id}`;
  const caller = nameOf(user(callerId));
  return {
    serverId,
    conversationKey,
    title: group.kind === "dm" ? nameOf(user(group.peerId)) : group.meta.name || "Group",
    body: group.kind === "dm" ? "Calling you" : `${caller} started a call`,
    muted: isMuted(prefs, conversationKey),
    hidden: false,
  };
}
