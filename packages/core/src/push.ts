// A notification for a message a phone heard about through a push, worded as
// a connected session would word it (maybeNotify in session.ts). It runs in the
// iOS app's Notification Service Extension, which has too little memory for a
// whole session and runs beside the app: it reads only the rows it needs from
// the local databases, never writes, and fetches the one message. The
// databases stay open for the next push, as the provider keeps them.

import * as wasm from "@zuna/crypto";
import { Api, decode } from "./api";
import { INDEX_DB, decodeAccount, label, serverDbName, serverKeyFor } from "./client";
import { openEnvelope } from "./crypto";
import type { DbProvider } from "./db";
import { fromBase64, fromUtf8 } from "./encoding";
import { notificationText } from "./notify";
import type { MessageBody, Preferences, Profile } from "./types";

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
}

interface StoredUser {
  username: string;
  profile: Profile;
  devices: { id: string; signatureKey: string }[];
}

interface StoredGroup {
  id: string;
  kind: "dm" | "group";
  peerId: string | null;
  meta: { name?: string };
}

export async function previewPush(
  options: { db: DbProvider; deviceKey: Uint8Array },
  serverId: string,
  groupId: string,
  messageId: string,
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
  const epochKey = wasm.aeadOpen(key, epochRow.key, label("epoch"));
  const opened = openEnvelope<MessageBody>(
    epochKey,
    fromBase64(device.signatureKey),
    "message",
    groupId,
    message.id,
    message.epoch,
    decode(message.envelope),
  );
  if (!opened.ok) return preview({});

  const prefsRow = db.get<{ v: Uint8Array }>("SELECT v FROM kv WHERE k = ?", ["prefs"]);
  const prefs = prefsRow ? read<Partial<Preferences>>("kv/prefs", prefsRow.v) : {};
  const mentioned = (opened.value.mentions ?? []).includes(account.userId);
  const text = notificationText(group.kind, group.meta.name, nameOf(sender), {
    text: opened.value.text ?? "",
    attachments: opened.value.attachments ?? [],
  });
  return preview({
    ...text,
    decrypted: true,
    muted: !mentioned && (prefs.muted ?? []).includes(conversationKey!),
  });
}
