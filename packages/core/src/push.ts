// A notification for a message a phone heard about through a push, worded as
// a connected session would word it (maybeNotify in session.ts). It runs in the
// iOS app's Notification Service Extension, which has too little memory for a
// whole session and runs beside the app: it reads only the rows it needs from
// the local databases, never writes, and fetches the one message. The
// databases stay open for the next push, as the provider keeps them.

import * as wasm from "@zuna/crypto";
import { Api, decode } from "./api";
import { INDEX_DB, decodeAccount, label, serverDbName, serverKeyFor } from "./client";
import { namesItsSender, openEnvelope } from "./crypto";
import type { DbProvider } from "./db";
import { concat, fromBase64, fromUtf8, toBase64 } from "./encoding";
import { notificationText, previewText } from "./notify";
import { isMuted, type AvatarRef, type Preferences, type Profile } from "./types";
import { parseMessageBody } from "./validate";

export interface PushPreview {
  serverId: string;
  /** The chat to open, when the device knows it. */
  conversationKey: string | null;
  title: string;
  body: string;
  /** False when the message can't be read yet, such as in an epoch this device hasn't seen: the text is then generic. */
  decrypted: boolean;
  /** The chat is muted and the message doesn't mention you. */
  muted: boolean;
  /** Nothing to show: your own message, or one deleted since. */
  hidden: boolean;
  /** For a notification laid out as a conversation: who wrote it, with their picture when asked for. */
  sender?: { id: string; name: string; picture?: string };
  /** The group it's in, with the group's picture when asked for. */
  group?: { name: string; picture?: string };
  /** The message alone, without the sender's name in front. */
  text?: string;
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
  kind: "dm" | "group";
  peerId: string | null;
  meta: { name?: string; avatar?: AvatarRef | null };
}

export async function previewPush(
  options: { db: DbProvider; deviceKey: Uint8Array },
  serverId: string,
  groupId: string,
  messageId: string,
  /** Also download and decrypt the sender's and the group's pictures, as base64. */
  pictures = false,
): Promise<PushPreview> {
  const key = serverKeyFor(options.deviceKey, serverId);
  const index = await options.db.open(INDEX_DB);
  const server = index.get<{ account: Uint8Array; name: string }>("SELECT account, name FROM servers WHERE id = ?", [serverId]);
  if (!server) throw new Error("This device isn't signed in to that server.");
  const account = decodeAccount(fromUtf8(wasm.aeadOpen(key, server.account, label("account"))));
  const db = await options.db.open(serverDbName(serverId));
  const read = <T>(name: string, data: Uint8Array): T => JSON.parse(fromUtf8(wasm.aeadOpen(key, data, label(name))));
  const user = (id: string | null) => {
    const row = id ? db.get<{ data: Uint8Array }>("SELECT data FROM users WHERE id = ?", [id]) : undefined;
    return row ? read<StoredUser>("user", row.data) : null;
  };
  const nameOf = (stored: StoredUser | null) => stored?.profile.displayName || stored?.username || "Someone";

  const groupRow = db.get<{ data: Uint8Array }>("SELECT data FROM groups WHERE id = ?", [groupId]);
  const group = groupRow ? read<StoredGroup>("group", groupRow.data) : null;
  const conversationKey = group ? (group.kind === "dm" ? `user:${group.peerId}` : `group:${group.id}`) : null;
  const preview = (fields: Partial<PushPreview>): PushPreview => ({
    serverId,
    conversationKey,
    // Without the message, at least the chat; without the chat, the server.
    title: group ? (group.kind === "dm" ? nameOf(user(group.peerId)) : group.meta.name || "Group") : server.name,
    body: "New message",
    decrypted: false,
    muted: false,
    hidden: false,
    ...fields,
  });

  const api = new Api(account.serverUrl);
  api.token = account.token;
  const message = await api.message(groupId, messageId).catch(() => null);
  if (!message) return preview({});
  if (message.deleted_at || !message.envelope || message.sender_user === account.userId) return preview({ hidden: true });

  const sender = user(message.sender_user);
  const device = sender?.devices.find((item) => item.id === message.sender_device);
  const epochRow = db.get<{ key: Uint8Array }>("SELECT key FROM epoch_keys WHERE group_id = ? AND epoch = ?", [groupId, message.epoch]);
  if (!group || !sender || !device || !epochRow) return preview({});
  // What the app wouldn't show as theirs isn't worded as theirs here either: a message
  // from a device in an epoch after it left, or after its epoch ended (couldBeSent in
  // session.ts), or from someone whose key changed in a way that doesn't follow.
  const left = db.get<{ epoch: number }>("SELECT epoch FROM device_departures WHERE group_id = ? AND device_id = ?", [groupId, message.sender_device]);
  const next = db.get<{ seq: number }>("SELECT seq FROM epoch_starts WHERE group_id = ? AND epoch = ?", [groupId, message.epoch + 1]);
  if ((left && message.epoch >= left.epoch) || (next && message.seq >= next.seq) || sender.trust === "changed") return preview({});
  const epochKey = wasm.aeadOpen(key, epochRow.key, label("epoch"));
  const opened = openEnvelope<unknown>(
    epochKey,
    fromBase64(device.signatureKey),
    "message",
    groupId,
    message.id,
    message.epoch,
    decode(message.envelope),
  );
  if (!opened.ok || !namesItsSender(opened.value, message.sender_user, message.sender_device)) return preview({});
  const body = parseMessageBody(opened.value);
  if (!body) return preview({});

  const prefsRow = db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", ["prefs"]);
  const prefs = prefsRow ? read<Partial<Preferences>>("kv/prefs", prefsRow.v) : {};
  const mentioned = (body.mentions ?? []).includes(account.userId);
  const content = { text: body.text ?? "", attachments: body.attachments ?? [] };
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
    ...notificationText(group.kind, group.meta.name, nameOf(sender), content),
    decrypted: true,
    muted: !mentioned && isMuted(prefs, conversationKey!),
    sender: { id: message.sender_user, name: nameOf(sender), picture: await picture(sender.profile.avatar) },
    group: group.kind === "group" ? { name: group.meta.name || "Group", picture: await picture(group.meta.avatar) } : undefined,
    text: previewText(content),
  });
}
