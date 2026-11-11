// A notification for a message a phone heard about through a push, worded as
// a connected session would word it (maybeNotify in session.ts). It runs in the
// iOS app's Notification Service Extension, which has too little memory for a
// whole session and runs beside the app: it reads only the rows it needs from
// the local databases, never writes, and fetches the one message, with the
// commits that led to its epoch if the app slept through them (`follow`). The
// databases stay open for the next push, as the provider keeps them. A call
// ringing is worded from what's on the device alone, with nothing to fetch.

import * as wasm from "@zuna/crypto";
import { Api, ApiError, decode, type ApiChannel, type ApiMessage } from "./api";
import { openChannelDetails } from "./channels";
import type { AccountState } from "./account";
import { INDEX_DB, decodeAccount, label, serverDbName, serverKeyFor } from "./client";
import { CONTENT_LABEL, checkEnvelope, namesItsSender, parseCertificate, type Signer } from "./crypto";
import type { DbProvider, LocalDb } from "./db";
import { concat, equalBytes, fromBase64, fromUtf8, toBase64, u64Bytes, utf8 } from "./encoding";
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
  /** False when the message can't be read yet, such as one from a device this one hasn't met: the text is then generic. */
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
  /**
   * The chat, for a message that can't be read, with its picture when asked for and the server
   * could be reached: the other person in a direct message, or the group. It's laid out as that
   * chat's, which its title says already, and says nothing of who wrote it.
   */
  chat?: { id: string; name: string; picture?: string };
  /** When the server took the message, by its clock (ms), if it could be fetched: a chat read after that has read it. */
  sentAt?: number;
}

/** Pictures are small; anything bigger isn't worth a notification extension's time. */
const MAX_PICTURE_CHUNKS = 4;

/**
 * How long a preview's steps may take, in ms. iOS gives a notification extension about half a
 * minute for all of it, and shows the push's own text after that, which names nobody. Tests
 * shorten them.
 */
export const pushTiming = {
  /** One request, where a session gives one half a minute. */
  request: 7_000,
  /**
   * The waits before the message is asked for again when the server couldn't be reached. A
   * phone that a push woke may be a moment from having a network, and gives up at once.
   */
  retries: [500, 1_500, 3_000],
  /** Everything before the pictures, after which nothing new is started. */
  budget: 18_000,
  /** Both pictures together. A notification without one shows initials. */
  pictures: 5_000,
};

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

/**
 * How much of one group's MLS state a preview takes into memory, in bytes as stored: an extension
 * has about 24 MB for everything. With hybrid keys a device's leaf takes about 38 KB as stored, so
 * this follows groups of up to about fifty devices (docs/POST_QUANTUM.md, "What it costs").
 */
const MAX_FOLLOWED_STATE = 2 << 20;
/** How far a preview reads on in a group's changes for the commits it's missing: pages, and how much is on each. */
const FOLLOWED_PAGES = 5;
const FOLLOWED_PAGE = 100;

/** An epoch a preview followed a group to: its key, and what its tree and the changes read say of who could send in it. */
interface Followed {
  key: Uint8Array;
  /** Whether this device of theirs, with this signing key, has a leaf in the epoch's tree. */
  holds(signer: Signer, signatureKey: Uint8Array): boolean;
  /** The server's sequence number the epoch after it started at, if one was seen. */
  nextStart: number | null;
}

/**
 * The key of an epoch this device hasn't been to. A group moves on while a phone's app sleeps:
 * whenever a device of anyone in it comes or goes, and each week. The session would apply the
 * commits in between and take the key from MLS, and so does this, on a copy of that one group's
 * MLS state that it lets go of afterwards. Nothing is written, so the app applies them again
 * when it next runs, with every check it makes of them. This follows only where it needs none of
 * those: a commit that changes the group's roster, which takes knowing who may, one that was
 * undone, or one that takes this device out ends it, and so does a state too big for an extension
 * to hold or a way too long to read. The message is then worded as one that can't be read yet.
 */
async function follow(
  held: { api: Api; db: LocalDb; key: Uint8Array; account: AccountState },
  groupId: string,
  epoch: number,
  /** When to have stopped asking the server for more. */
  deadline: number,
): Promise<Followed | null> {
  const { api, db, key, account } = held;
  const group = utf8(groupId);
  // Before the state, so that a session writing meanwhile can only leave commits to skip, never one missed.
  let after = db.get<{ synced_seq: number }>("SELECT synced_seq FROM groups WHERE id = ?", [groupId])?.synced_seq ?? 0;
  // OpenMLS names each row it keeps for a group with the group's ID, written as JSON's list of its bytes.
  const named = utf8(`[${[...group].join(",")}]`);
  const size = db.get<{ size: number | null }>("SELECT SUM(LENGTH(v)) AS size FROM mls_kv WHERE instr(k, ?) > 0", [named])?.size ?? 0;
  if (size === 0 || size > MAX_FOLLOWED_STATE) return null;
  const rows = db.all<{ k: Uint8Array; v: Uint8Array }>("SELECT k, v FROM mls_kv WHERE instr(k, ?) > 0", [named]);
  let mls: wasm.MlsClient | null = null;
  try {
    mls = new wasm.MlsClient(
      account.devicePublic,
      account.deviceSecret,
      account.certificate,
      rows.map((row) => [row.k, wasm.aeadOpen(key, row.v, label(`mls|${toBase64(row.k)}`))]) as unknown as any[],
    );
    if (!mls.hasGroup(group)) return null;
    let at = mls.epoch(group);
    if (at > epoch) return null;
    const roster = mls.roster(group);
    let nextStart: number | null = null;
    for (let page = 0, more = at < epoch; more && page < FOLLOWED_PAGES; page++) {
      if (Date.now() + pushTiming.request > deadline) return null;
      const changes = await api.changes(groupId, after, FOLLOWED_PAGE);
      for (const event of [...changes.events].sort((a, b) => a.seq - b.seq)) {
        if (!Number.isSafeInteger(event.seq) || !Number.isSafeInteger(event.epoch) || event.kind === "commit_voided") return null;
        if (event.kind !== "commit" || event.epoch <= at) continue;
        if (at === epoch) {
          // The epoch after it has begun: nothing that came later was sent in this one.
          nextStart = event.seq;
          break;
        }
        if (event.epoch !== at + 1 || !event.data) return null;
        const processed = mls.processCommit(group, decode(event.data)) as { epoch: number; selfRemoved: boolean };
        const now = mls.roster(group);
        if (processed.selfRemoved || processed.epoch !== event.epoch || !!now !== !!roster || (now && roster && !equalBytes(now, roster))) return null;
        at = processed.epoch;
      }
      more = changes.has_more && nextStart === null;
      after = changes.cursor;
    }
    if (at !== epoch) return null;
    const leaves = (mls.members(group) as { credential: Uint8Array; signatureKey: Uint8Array }[]).map((leaf) => ({ cert: parseCertificate(leaf.credential), signatureKey: leaf.signatureKey }));
    return {
      key: mls.exportSecret(group, CONTENT_LABEL, u64Bytes(epoch), 32),
      holds: (signer, signatureKey) => leaves.some((leaf) => leaf.cert?.userId === signer.userId && leaf.cert.deviceId === signer.deviceId && equalBytes(leaf.signatureKey, signatureKey)),
      nextStart,
    };
  } catch {
    // A commit MLS won't take, or changes that aren't as the server should give them.
    return null;
  } finally {
    mls?.free();
  }
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

  const deadline = Date.now() + pushTiming.budget;
  const api = new Api(account.serverUrl);
  api.token = account.token;
  api.timeout = pushTiming.request;
  // A picture that's slow to come is left out, so that the words aren't kept waiting for it.
  let picturesBy = 0;
  const picture = async (avatar: AvatarRef | null | undefined) => {
    if (!pictures || !avatar || avatar.chunks > MAX_PICTURE_CHUNKS) return undefined;
    picturesBy ||= Date.now() + pushTiming.pictures;
    const load = async () => {
      const key = fromBase64(avatar.key);
      const prefix = fromBase64(avatar.prefix);
      const parts: Uint8Array[] = [];
      for (let index = 0; index < avatar.chunks; index++) {
        const sealed = await api.downloadChunk(avatar.fileId, index);
        parts.push(wasm.streamOpen(key, prefix, index, index === avatar.chunks - 1, sealed));
      }
      return toBase64(concat(...parts));
    };
    let stop = () => {};
    const late = new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, picturesBy - Date.now()));
      stop = () => clearTimeout(timer);
    });
    return Promise.race([load().catch(() => undefined), late]).finally(stop);
  };
  // A message that can't be read: that there is one, and in which chat. Its picture isn't asked for from a server that didn't answer.
  const unread = async (reached = true): Promise<PushPreview> => {
    if (!group) return preview({});
    const peer = group.kind === "dm" ? user(group.peerId) : null;
    const avatar = !reached ? null : group.kind === "dm" ? peer?.profile.avatar : group.kind === "group" ? group.meta.avatar : null;
    return preview({ chat: { id: group.kind === "dm" ? (group.peerId ?? group.id) : group.id, name: group.kind === "dm" ? nameOf(peer) : groupName, picture: await picture(avatar) } });
  };

  let message: ApiMessage | null = null;
  for (let attempt = 0; !message; attempt++) {
    try {
      message = await api.message(groupId, messageId);
    } catch (error) {
      // Only what may go better the next time: no network yet, or a server that's starting.
      const wait = pushTiming.retries[attempt];
      if (!(error instanceof ApiError) || !error.retryable || wait === undefined || Date.now() + wait + pushTiming.request > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  if (!message) return unread(false);
  if (Number.isSafeInteger(message.created_at)) sentAt = message.created_at;
  if (message.deleted_at || !message.envelope) return preview({ hidden: true });

  if (!group) return unread();
  const epochRow = db.get<{ key: Uint8Array }>("SELECT key FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, message.epoch]);
  // An epoch this device hasn't been to is followed to.
  const followed = epochRow ? null : await follow({ api, db, key, account }, groupId, message.epoch, deadline);
  if (!epochRow && !followed) return unread();
  const epochKey = epochRow ? wasm.aeadOpen(key, epochRow.key, label(`epoch|${groupId}:${message.epoch}`)) : followed!.key;
  // Who sent it is inside, under their device's signature: the server isn't told.
  const deviceKey = (signer: Signer) => {
    const device = user(signer.userId)?.devices.find((item) => item.id === signer.deviceId);
    return device && fromBase64(device.signatureKey);
  };
  const checked = checkEnvelope<unknown>(epochKey, "message", groupId, message.id, message.epoch, decode(message.envelope), deviceKey);
  if (checked.state !== "signed" || !namesItsSender(checked.value, checked.signer.userId, checked.signer.deviceId)) return unread();
  const { userId: senderUser, deviceId: senderDevice } = checked.signer;
  if (senderUser === account.userId) return preview({ hidden: true });
  const sender = user(senderUser);
  if (!sender) return unread();
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
  const recorded = () =>
    couldBeSent(
      {
        left: () => value(departure.name, departure.row(groupId, senderUser, senderDevice), db.get<{ epoch: Uint8Array }>("SELECT epoch FROM device_departures WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, senderUser, senderDevice])?.epoch, departure.careful),
        joined: () => value(joined.name, joined.row(groupId), db.get<{ epoch: Uint8Array }>("SELECT epoch FROM joined_epochs WHERE group_id = ?", [groupId])?.epoch, joined.careful),
        arrived: () => value(arrival.name, arrival.row(groupId, senderUser, senderDevice), db.get<{ epoch: Uint8Array }>("SELECT epoch FROM device_arrivals WHERE group_id = ? AND user_id = ? AND device_id = ?", [groupId, senderUser, senderDevice])?.epoch, arrival.careful),
        nextStart: () => value(epochStart.name, epochStart.row(groupId, message.epoch + 1), db.get<{ seq: Uint8Array }>("SELECT seq FROM epoch_starts WHERE group_id = ? AND epoch = ?", [groupId, message.epoch + 1])?.seq, epochStart.careful),
      },
      message,
    );
  // Of an epoch followed to, this device has no records of its own yet: the epoch's tree says whose devices were in it.
  const sendable = followed ? followed.holds(checked.signer, deviceKey(checked.signer)!) && (followed.nextStart === null || message.seq < followed.nextStart) : recorded();
  if (!sendable || sender.trust === "changed") return unread();
  const body = parseMessageBody(checked.value);
  if (!body) return unread();

  const prefsRow = db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", ["prefs"]);
  const prefs = prefsRow ? read<Partial<Preferences>>("kv", "prefs", prefsRow.v) : {};
  if (prefs.blocked?.includes(senderUser)) return preview({ hidden: true });
  // A reply counts if this device holds the message replied to, as for the session's "@".
  const repliedTo = body.replyTo ? db.get<{ sender_user: string }>("SELECT sender_user FROM messages WHERE group_id = ? AND id = ?", [groupId, body.replyTo]) : undefined;
  const mentioned = (body.mentions ?? []).includes(account.userId) || repliedTo?.sender_user === account.userId;
  const content = { text: body.text ?? "", attachments: body.attachments ?? [], location: body.location };
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
