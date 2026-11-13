// What a server says it keeps about an account (`POST /api/account/export`), put in plain
// words for the settings page that shows it. The words are the same on every platform,
// so they're written once, here, and the apps only lay them out.

import type { ApiExport, ApiExportConversation, ApiExportDevice } from "./api";
import type { ServerDataExport, ServerDataKind, ServerDataRow, ServerDataSection } from "./types";

/** What this device knows that the server doesn't, to tell the person which row is which. */
export interface ExportContext {
  /** This device's ID. */
  deviceId: string;
  /** What this device calls each of the account's devices. */
  deviceName(id: string): string | undefined;
  /** What a conversation is called on this device. */
  conversationName(id: string): string | undefined;
  /** The server's address. */
  serverUrl: string;
}

/** The server's answer, to save, and the same in plain words, to show. */
export function describeExport(raw: ApiExport, context: ExportContext): ServerDataExport {
  const sections = [
    accountSection(raw),
    signInSection(raw),
    devicesSection(raw, context),
    conversationsSection(raw, context),
    vaultSection(raw),
    filesSection(raw),
    sendingSection(raw),
    madeSection(raw),
    keysSection(raw),
    notKeptSection(),
  ].filter((section): section is ServerDataSection => section !== null);
  return { json: JSON.stringify(raw, null, 2), fileName: fileName(raw, context.serverUrl), sections };
}

function fileName(raw: ApiExport, serverUrl: string): string {
  let host = "server";
  try {
    host = new URL(serverUrl).host;
  } catch {
    // An address that doesn't parse names nothing.
  }
  const safe = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-");
  return `zuna-${safe(host)}-${safe(raw.account.username || raw.account.id)}-${day(raw.exported_at)}.json`;
}

const row = (label: string, value: string, kind: ServerDataKind, note?: string): ServerDataRow => (note ? { label, value, kind, note } : { label, value, kind });

const pad = (n: number) => String(n).padStart(2, "0");

/** A day as `2026-11-12`, in this device's time. */
function day(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** A moment as `2026-11-12 17:05`, in this device's time: Intl isn't in every host's engine. */
export function stamp(ms: number): string {
  const at = new Date(ms);
  return `${day(ms)} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function bytes(n: number): string {
  if (n < 1024) return n === 1 ? "1 byte" : `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

/** 12,345, as Intl's numbers aren't in every host's engine. */
function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${thousands(n)} ${n === 1 ? one : many}`;
}

/** How many bytes a base64 string holds. */
function sizeOf(base64: string | null | undefined): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function names(usernames: string[]): string {
  const shown = usernames.map((name) => (name ? `@${name}` : "a deleted account"));
  if (shown.length <= 2) return shown.join(" and ");
  return `${shown.slice(0, 2).join(", ")} and ${count(shown.length - 2, "more", "more")}`;
}

function accountSection(raw: ApiExport): ServerDataSection {
  const a = raw.account;
  const rows = [
    row("Username", `@${a.username}`, "readable"),
    row("Account ID", a.id, "readable"),
    row("Role", a.role[0]!.toUpperCase() + a.role.slice(1), "readable"),
    row("Created", stamp(a.created_at), "readable"),
    row(
      "Last online",
      a.last_seen_at ? stamp(a.last_seen_at) : "Not yet",
      "readable",
      a.hide_last_seen ? "Kept even though you hide when you're online, which hides it from other people only." : undefined,
    ),
  ];
  if (a.banned_at) rows.push(row("Banned", stamp(a.banned_at), "readable"));
  rows.push(row("Profile", bytes(sizeOf(a.profile)), "encrypted", "Your display name, bio and the key to your picture, sealed so that only people on this server can open it."));
  if (a.avatar_file) {
    const file = raw.files.find((f) => f.id === a.avatar_file);
    rows.push(row("Profile picture", file ? bytes(file.size) : "Kept", "encrypted", "Encrypted with a key that's in your profile."));
  }
  rows.push(
    row("Your account's keys", bytes(sizeOf(a.vault_core)), "encrypted", "Sealed with your account key, which only your password, your recovery key and your devices can open."),
    row(
      "Your public keys",
      bytes(sizeOf(a.identity_key) + sizeOf(a.identity_head) + sizeOf(a.hpke_key) + sizeOf(a.hpke_key_sig) + sizeOf(a.profile_sig)),
      "public",
      "Your identity key, which the emoji people compare come from, and the key others encrypt to you with, with their signatures.",
    ),
    row("Storage counted", bytes(a.stored_bytes + a.commit_bytes), "readable", "What your vault and the changes you made to conversations' keys take up, which the server's limits count."),
    row("Reports about you", "Left out", "withheld", "If someone reported you to the server's admins, why and when are kept for them. That's left out here, so that nobody can tell from it when they were reported."),
  );
  return {
    id: "account",
    title: "Your account",
    about: "Your account's own record. The server reads your username, your role and the times. Your name, bio and picture are in your profile, which it can't open.",
    rows,
  };
}

function signInSection(raw: ApiExport): ServerDataSection {
  const s = raw.sign_in;
  const rows = [
    row("Password check", bytes(s.auth_hash_size), "withheld", "Made from your password on your device. The server checks sign-ins against it."),
    row("Recovery key check", bytes(s.recovery_hash_size), "withheld", "The same, for your recovery key."),
  ];
  for (const slot of s.slots) {
    const password = slot.kind === "password";
    rows.push(
      row(
        password ? "Keys sealed to your password" : slot.kind === "recovery" ? "Keys sealed to your recovery key" : `Keys sealed to “${slot.kind}”`,
        bytes(slot.size),
        "withheld",
        `Your account key, sealed so that only your ${password ? "password" : "recovery key"} opens it.`,
      ),
    );
  }
  const mib = Math.round(s.kdf.memory / 1024);
  rows.push(
    row(
      "How your password is stretched",
      `Argon2id, ${mib} MiB, ${count(s.kdf.iterations, "pass", "passes")}`,
      "readable",
      "Told to anyone who asks to sign in as you, so that their app can try. It says nothing about your password.",
    ),
  );
  if (s.attempts) {
    rows.push(row("Sign-in attempts", `${s.attempts.attempts}, the last ${stamp(s.attempts.seen_at)}`, "readable", "Every attempt to sign in as you is counted, from anywhere, so that nobody can keep guessing. Forgotten a day after the last."));
  }
  return {
    id: "sign-in",
    title: "Signing in",
    about: "What the server checks your password and recovery key against. It can't turn any of it back into them, and it's left out of the export, as anyone with a copy could test guesses at your password.",
    rows,
  };
}

function deviceLabel(device: ApiExportDevice, context: ExportContext): string {
  const name = context.deviceName(device.id);
  if (device.id === context.deviceId) return `${name ?? "This device"}${name ? " (this device)" : ""}`;
  return name ?? (device.revoked_at ? "A removed device" : "A device");
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function devicesSection(raw: ApiExport, context: ExportContext): ServerDataSection {
  const devices = [...raw.devices].sort(
    (a, b) =>
      Number(b.id === context.deviceId) - Number(a.id === context.deviceId) ||
      Number(a.revoked_at !== null) - Number(b.revoked_at !== null) ||
      b.last_seen_at - a.last_seen_at,
  );
  const rows: ServerDataRow[] = [];
  for (const device of devices) {
    const parts = [`Signed in ${stamp(device.created_at)}.`];
    if (device.sessions.length) parts.push(`${count(device.sessions.length, "session")}, the last used ${stamp(Math.max(...device.sessions.map((s) => s.last_used_at)))}.`);
    if (!device.revoked_at) {
      parts.push("Its public keys, which others encrypt to it with and check what it signs against.");
      if (device.key_packages.count) parts.push(`${count(device.key_packages.count, "key")} for others to add it to conversations with, ${bytes(device.key_packages.bytes)}.`);
      if (device.welcomes.count) parts.push(`${count(device.welcomes.count, "invitation")} to conversations waiting for it, ${bytes(device.welcomes.bytes)}, encrypted.`);
      if (device.account_key) parts.push(`Your account key sealed to it, ${bytes(device.account_key.size)}.`);
    }
    rows.push(
      row(
        deviceLabel(device, context),
        device.revoked_at ? `Removed ${stamp(device.revoked_at)}` : `Last used ${stamp(device.last_seen_at)}`,
        "readable",
        parts.join(" "),
      ),
    );
  }
  for (const device of devices) {
    const push = device.push;
    if (!push) continue;
    const muted = Object.keys(push.muted ?? {}).length;
    const parts = ["The relay's handles for it are left out, as they'd let anyone wake it."];
    if (muted) parts.push(`${count(muted, "chat")} muted there, so as not to be pushed.`);
    if (push.notified.length) parts.push(`Notified about ${count(push.notified.length, "chat")} not read since.`);
    if (push.filters) parts.push("It hides what it shouldn't show itself, so it's pushed for everything.");
    rows.push(row(`Notifications for ${deviceLabel(device, context)}`, `Through ${hostOf(push.relay)}`, "readable", parts.join(" ")));
  }
  if (raw.signing_in.length) {
    rows.push(row("Signing in", count(raw.signing_in.length, "session"), "readable", "Sign-ins that haven't added a device yet."));
  }
  return {
    id: "devices",
    title: "Devices",
    about: "Each device that has signed in to your account: when, when it was last used, and its public keys. What each is called is only on your devices.",
    rows,
  };
}

function conversationLabel(chat: ApiExportConversation, selfId: string): string {
  const others = chat.members.filter((member) => member.id !== selfId);
  if (chat.kind === "dm") {
    const pair = (chat.dm_key ?? "").split(":");
    const peer = pair[0] === selfId ? pair[1] : pair[0];
    if (peer === selfId || (!peer && others.length === 0)) return "Your saved messages";
    const username = chat.members.find((member) => member.id === peer)?.username;
    return username === undefined ? "Direct message with someone who left it" : `Direct message with ${names([username])}`;
  }
  if (chat.kind === "channel") return `Channel with ${count(chat.member_count, "member")}`;
  return others.length ? `Group with ${names(others.map((member) => member.username))}` : "Group with only you";
}

function conversationsSection(raw: ApiExport, context: ExportContext): ServerDataSection {
  const selfId = raw.account.id;
  const chats = [...raw.conversations].sort((a, b) => (b.messages.last ?? b.created_at) - (a.messages.last ?? a.created_at));
  const rows = chats.map((chat) => {
    const parts: string[] = [];
    const name = context.conversationName(chat.id);
    if (name) parts.push(`On your devices: “${name}”.`);
    parts.push(
      chat.messages.count
        ? `${count(chat.messages.count, "message")}, ${bytes(chat.messages.bytes)} encrypted, the last ${stamp(chat.messages.last ?? chat.created_at)}.`
        : "No messages kept.",
    );
    if (chat.meta_size) parts.push(`Its name, picture and description: ${bytes(chat.meta_size)}, encrypted.`);
    if (chat.by_you.count) parts.push(`${count(chat.by_you.count, "change")} to who's in it or its keys by you, the last ${stamp(chat.by_you.last ?? chat.created_at)}.`);
    if (chat.to_you.count) parts.push(`${count(chat.to_you.count, "change")} about you.`);
    if (chat.created_by === selfId) parts.push("You started it.");
    return row(conversationLabel(chat, selfId), chat.membership ? `Joined ${stamp(chat.membership.joined_at)}` : "Left", "readable", parts.join(" "));
  });
  if (!rows.length) rows.push(row("Conversations", "None", "readable"));
  return {
    id: "conversations",
    title: "Conversations",
    about: "The server knows who's in each conversation, when they joined, and when and how much is sent in it. What's said, who said it, and what a group or channel is called are encrypted.",
    rows,
  };
}

function vaultSection(raw: ApiExport): ServerDataSection {
  const { items, history_grants: grants } = raw.vault;
  return {
    id: "vault",
    title: "Your vault",
    about: "Your settings, your chat list, who you block, the keys to earlier messages and what you've saved, encrypted so that only your devices can open it.",
    rows: [
      row("Items", items.count ? `${count(items.count, "item")}, ${bytes(items.bytes)}` : "None", "encrypted"),
      row("History shared with you", grants.count ? `${count(grants.count, "grant")}, ${bytes(grants.bytes)}` : "None", "encrypted", "Keys to messages from before you joined a group, sealed to you."),
    ],
  };
}

function filesSection(raw: ApiExport): ServerDataSection {
  const rows = raw.files.map((file) => {
    const label =
      file.id === raw.account.avatar_file ? "Your profile picture" : file.standalone ? "A picture" : file.completed_at === null ? "An unfinished upload" : "A file not sent yet";
    return row(label, bytes(file.size), "encrypted", `Uploaded ${stamp(file.created_at)}.`);
  });
  if (!rows.length) rows.push(row("Files that are yours", "None", "readable"));
  const mib = raw.uploads.reduce((sum, upload) => sum + upload.mib, 0);
  rows.push(
    row(
      "Uploaded in the last 30 days",
      raw.uploads.length ? `${mib} MiB on ${count(raw.uploads.length, "day")}` : "Nothing",
      "readable",
      "Counted in whole MiB a day, against how much you may upload.",
    ),
  );
  return {
    id: "files",
    title: "Files",
    about: "Files you've uploaded that no message carries, such as your profile picture. Once a message carries a file, the server no longer knows whose it is. Every file is encrypted before it's uploaded.",
    rows,
  };
}

function sendingSection(raw: ApiExport): ServerDataSection {
  const issued = raw.tokens.reduce((sum, tokens) => sum + tokens.issued, 0);
  const periods = new Set(raw.tokens.map((tokens) => tokens.period));
  const last = Math.max(0, ...periods);
  return {
    id: "sending",
    title: "Sending",
    about: "Your devices are given tokens that pay for each message, reaction and edit. A token can't be tied back to whoever was given it once it's spent, so the server can't tell which messages are yours.",
    rows: [
      row(
        "Tokens given to you",
        issued ? `${thousands(issued)} in ${count(periods.size, "six-hour span")}` : "None kept",
        "readable",
        issued ? `The last six hours began ${stamp(last)}. Forgotten once they can't be spent.` : "Forgotten once they can't be spent.",
      ),
    ],
  };
}

function madeSection(raw: ApiExport): ServerDataSection | null {
  const rows: ServerDataRow[] = [];
  for (const invite of raw.invites) {
    const parts = [`Made ${stamp(invite.created_at)}.`];
    if (invite.expires_at) parts.push(`${invite.expires_at > raw.exported_at ? "Expires" : "Expired"} ${stamp(invite.expires_at)}.`);
    if (invite.revoked_at) parts.push(`Revoked ${stamp(invite.revoked_at)}.`);
    parts.push("Its code is left out, as anyone with it could join.");
    rows.push(row(invite.grants_role === "member" ? "Invite" : `Invite for ${invite.grants_role === "admin" ? "an admin" : invite.grants_role}`, `Used ${invite.uses}${invite.max_uses ? ` of ${invite.max_uses}` : ""}`, "readable", parts.join(" ")));
  }
  for (const bot of raw.bots) {
    const parts = [`Made ${stamp(bot.created_at)}.`];
    if (bot.deleted_at) parts.push(`Deleted ${stamp(bot.deleted_at)}.`);
    else if (!bot.set_up_at) parts.push("Not set up yet.");
    if (bot.channels.length) parts.push(`Given ${count(bot.channels.length, "channel")}.`);
    parts.push("Its name, picture and commands are encrypted, in its own profile.");
    rows.push(row(`@${bot.username}`, bot.listed ? "Listed bot" : "Private bot", "readable", parts.join(" ")));
  }
  if (raw.admin.channels.length) rows.push(row("Channels you made", String(raw.admin.channels.length), "readable", "Their names and topics are encrypted."));
  if (raw.admin.sounds.length) rows.push(row("Sounds you added", String(raw.admin.sounds.length), "readable", "What each is called and sounds like is encrypted."));
  if (raw.admin.banned.length) rows.push(row("People you banned", names(raw.admin.banned.map((user) => user.username)), "readable"));
  if (!rows.length) return null;
  return { id: "made", title: "What you've made", about: "Invites, bots, channels and sounds you made, and who you banned.", rows };
}

function keysSection(raw: ApiExport): ServerDataSection {
  const links = raw.key_changes.links;
  const last = links[links.length - 1];
  return {
    id: "keys",
    title: "Your keys over time",
    about: "Each time your account's keys were replaced, and the server's log of whose keys are whose, which everyone's apps check.",
    rows: [
      row(
        "Keys replaced",
        links.length ? count(links.length, "time") : "Never",
        "public",
        last ? `The last ${stamp(last.created_at)}. Each signed by the keys before, as when a device is removed or your password changes.` : "As happens when a device is removed or your password changes.",
      ),
      row("Entries in the log of keys", String(raw.key_changes.log_entries), "public", "Which devices you have and their keys, in public, so that the server can't show people different ones."),
    ],
  };
}

function notKeptSection(): ServerDataSection {
  return {
    id: "not-kept",
    title: "What it doesn't keep",
    about: "These never reach the server, or reach it only in a form it can't read or tie to you.",
    rows: [
      row("What you write, send and say", "Not kept", "none", "Messages, files, reactions, calls and voice are encrypted on your device for the people in the conversation, and kept only as the sizes above."),
      row("Who sent each message, reaction or pin", "Not kept", "none", "They're sent without your account, and who wrote them is signed inside, where only the people in the conversation see it."),
      row("Your password and recovery key", "Not kept", "none", "They never leave your device."),
      row("Who you block and what you pin", "Not kept", "none", "They're in your vault, encrypted."),
      row("What you search for", "Not kept", "none", "Search runs on your device."),
      row("Who reports someone", "Not kept", "none", "A report keeps only whom it's about, why and when."),
      row("Your IP address", "Not stored", "none", "The server sees it with each request, and counts requests by it in memory for at most a day so that nobody floods it. It never writes it down, though a proxy in front of it may log it, and the voice server sees it too while you're in a call. With a SOCKS5 proxy set on a device, it sees the proxy's address instead."),
    ],
  };
}
