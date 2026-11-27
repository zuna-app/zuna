// What a server says it keeps about an account (`POST /api/account/export`), put in plain
// words for the settings page that shows it. The words are the same on every platform,
// so they're written once, here, and the apps only lay them out.

import type { ApiExport, ApiExportConversation, ApiExportDevice } from "./api";
import { t } from "./i18n";
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
  if (n < 1024) return t("export.bytes", { count: n });
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < 3) {
    value /= 1024;
    unit++;
  }
  const size = value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  if (unit === 0) return t("export.kb", { size });
  if (unit === 1) return t("export.mb", { size });
  if (unit === 2) return t("export.gb", { size });
  return t("export.tb", { size });
}

/** 12,345, as Intl's numbers aren't in every host's engine. */
export function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** How many bytes a base64 string holds. */
function sizeOf(base64: string | null | undefined): number {
  if (!base64) return 0;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function names(usernames: string[]): string {
  const shown = usernames.map((name) => (name ? `@${name}` : t("export.aDeletedAccount")));
  if (shown.length <= 1) return shown.join("");
  const [first, second] = shown as [string, string];
  if (shown.length === 2) return t("export.twoNames", { first, second });
  return t("export.namesAndMore", { count: shown.length - 2, first, second });
}

function roleName(role: string): string {
  if (role === "owner") return t("export.owner");
  if (role === "admin") return t("export.admin");
  if (role === "member") return t("export.member");
  return role;
}

function accountSection(raw: ApiExport): ServerDataSection {
  const a = raw.account;
  const rows = [
    row(t("export.username"), `@${a.username}`, "readable"),
    row(t("export.accountId"), a.id, "readable"),
    row(t("export.role"), roleName(a.role), "readable"),
    row(t("export.created"), stamp(a.created_at), "readable"),
    row(
      t("export.lastOnline"),
      a.last_seen_at ? stamp(a.last_seen_at) : t("export.notYet"),
      "readable",
      a.hide_last_seen ? t("export.keptEvenIfYouHide") : undefined,
    ),
  ];
  if (a.banned_at) rows.push(row(t("export.banned"), stamp(a.banned_at), "readable"));
  rows.push(row(t("export.profile"), bytes(sizeOf(a.profile)), "encrypted", t("export.yourDisplayNameBioAnd")));
  if (a.avatar_file) {
    const file = raw.files.find((f) => f.id === a.avatar_file);
    rows.push(row(t("export.profilePicture"), file ? bytes(file.size) : t("export.kept"), "encrypted", t("export.encryptedWithAKeyThats")));
  }
  rows.push(
    row(t("export.yourAccountsKeys"), bytes(sizeOf(a.vault_core)), "encrypted", t("export.encryptedWithYourAccountKey")),
    row(
      t("export.yourPublicKeys"),
      bytes(sizeOf(a.identity_key) + sizeOf(a.identity_head) + sizeOf(a.hpke_key) + sizeOf(a.hpke_key_sig) + sizeOf(a.profile_sig)),
      "public",
      t("export.yourIdentityKeyWhichThe"),
    ),
    row(t("export.storageCounted"), bytes(a.stored_bytes + a.commit_bytes), "readable", t("export.howMuchSpaceYourVault")),
    row(t("export.reportsAboutYou"), t("export.leftOut"), "withheld", t("export.ifSomeoneReportedYouThe")),
  );
  return {
    id: "account",
    title: t("export.yourAccount"),
    about: t("export.yourAccountsOwnRecord"),
    rows,
  };
}

function signInSection(raw: ApiExport): ServerDataSection {
  const s = raw.sign_in;
  const rows = [
    row(t("export.passwordCheck"), bytes(s.auth_hash_size), "withheld", t("export.madeFromYourPasswordOn")),
    row(t("export.recoveryKeyCheck"), bytes(s.recovery_hash_size), "withheld", t("export.theSameForYourRecovery")),
  ];
  for (const slot of s.slots) {
    const password = slot.kind === "password";
    rows.push(
      row(
        password ? t("export.keysLockedWithYourPassword") : slot.kind === "recovery" ? t("export.keysLockedWithYourRecovery") : t("export.keysLockedWith", { kind: slot.kind }),
        bytes(slot.size),
        "withheld",
        password ? t("export.yourAccountKeyEncryptedSo") : t("export.yourAccountKeyEncryptedSoOnly"),
      ),
    );
  }
  const mib = Math.round(s.kdf.memory / 1024);
  rows.push(
    row(
      t("export.howYourPasswordIsHashed"),
      t("export.hashSettings", { mib, count: thousands(s.kdf.iterations) }),
      "readable",
      t("export.givenToAnyoneWhoTries"),
    ),
  );
  if (s.attempts) {
    rows.push(
      row(
        t("export.signInAttempts"),
        t("export.attemptsAndLast", { count: s.attempts.attempts, when: stamp(s.attempts.seen_at) }),
        "readable",
        t("export.everyAttemptToSignIn"),
      ),
    );
  }
  return {
    id: "sign-in",
    title: t("export.signingIn"),
    about: t("export.whatTheServerChecksYour"),
    rows,
  };
}

function deviceLabel(device: ApiExportDevice, context: ExportContext): string {
  const name = context.deviceName(device.id);
  if (device.id === context.deviceId) return name ? t("export.thisDeviceNamed", { name }) : t("export.thisDevice");
  return name ?? (device.revoked_at ? t("export.aRemovedDevice") : t("export.aDevice"));
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
    const parts = [t("export.signedIn", { when: stamp(device.created_at) })];
    if (device.sessions.length) {
      const last = stamp(Math.max(...device.sessions.map((s) => s.last_used_at)));
      parts.push(t("export.sessionsTheLastUsed", { count: device.sessions.length, when: last }));
    }
    if (!device.revoked_at) {
      parts.push(t("export.itsPublicKeysWhichOthers"));
      if (device.key_packages.count) {
        parts.push(t("export.keysOthersCanUseTo", { count: thousands(device.key_packages.count), size: bytes(device.key_packages.bytes) }));
      }
      if (device.welcomes.count) {
        parts.push(t("export.invitationsToConversationsWaitingFor", { count: thousands(device.welcomes.count), size: bytes(device.welcomes.bytes) }));
      }
      if (device.account_key) parts.push(t("export.yourAccountKeyEncryptedFor", { size: bytes(device.account_key.size) }));
    }
    rows.push(
      row(
        deviceLabel(device, context),
        device.revoked_at ? t("export.removed", { when: stamp(device.revoked_at) }) : t("export.lastUsed", { when: stamp(device.last_seen_at) }),
        "readable",
        parts.join(" "),
      ),
    );
  }
  for (const device of devices) {
    const push = device.push;
    if (!push) continue;
    const muted = Object.keys(push.muted ?? {}).length;
    const parts = [t("export.itsPushNotificationHandlesAre")];
    if (muted) parts.push(t("export.noNotificationsForMutedChats", { count: thousands(muted) }));
    if (push.notified.length) parts.push(t("export.notifiedAboutChatsUnreadSince", { count: thousands(push.notified.length) }));
    if (push.filters) parts.push(t("export.itFiltersNotificationsItselfSo"));
    rows.push(row(t("export.notificationsFor", { device: deviceLabel(device, context) }), t("export.through", { host: hostOf(push.relay) }), "readable", parts.join(" ")));
  }
  if (raw.signing_in.length) {
    rows.push(row(t("export.signingIn"), t("export.sessions", { count: thousands(raw.signing_in.length) }), "readable", t("export.signInsThatHaventAdded")));
  }
  return {
    id: "devices",
    title: t("export.devices"),
    about: t("export.eachDeviceThatHasSigned"),
    rows,
  };
}

function conversationLabel(chat: ApiExportConversation, selfId: string): string {
  const members = chat.members ?? [];
  const others = members.filter((member) => member.id !== selfId);
  if (chat.kind === "dm") {
    const pair = (chat.dm_key ?? "").split(":");
    const peer = pair[0] === selfId ? pair[1] : pair[0];
    if (peer === selfId || (!peer && others.length === 0)) return t("export.yourSavedMessages");
    const username = members.find((member) => member.id === peer)?.username;
    return username === undefined ? t("export.directMessageWithSomeoneWho") : t("export.directMessageWith", { names: names([username]) });
  }
  // Who's in it now is for those in it.
  if (!chat.membership) return chat.kind === "channel" ? t("export.formerChannel") : t("export.formerGroup");
  if (chat.kind === "channel") return t("export.channelWithMembers", { count: thousands(chat.member_count ?? 0) });
  return others.length ? t("export.groupWith", { names: names(others.map((member) => member.username)) }) : t("export.groupWithOnlyYou");
}

function conversationsSection(raw: ApiExport, context: ExportContext): ServerDataSection {
  const selfId = raw.account.id;
  const chats = [...raw.conversations].sort((a, b) => (b.messages?.last ?? b.created_at) - (a.messages?.last ?? a.created_at));
  const rows = chats.map((chat) => {
    const parts: string[] = [];
    const name = context.conversationName(chat.id);
    if (name) parts.push(t("export.onYourDevices", { name }));
    const messages = chat.messages;
    if (messages) {
      parts.push(
        messages.count
          ? t("export.messagesEncryptedTheLast", {
              count: thousands(messages.count),
              size: bytes(messages.bytes),
              when: stamp(messages.last ?? chat.created_at),
            })
          : t("export.noMessagesKept"),
      );
    }
    if (chat.meta_size) parts.push(t("export.itsNamePictureAndDescription", { size: bytes(chat.meta_size) }));
    if (chat.by_you.count) {
      parts.push(t("export.changesYouMadeToIts", { count: thousands(chat.by_you.count), when: stamp(chat.by_you.last ?? chat.created_at) }));
    }
    if (chat.to_you.count) parts.push(t("export.changesAboutYou", { count: thousands(chat.to_you.count) }));
    if (chat.created_by === selfId) parts.push(t("export.youStartedIt"));
    return row(conversationLabel(chat, selfId), chat.membership ? t("export.joined", { when: stamp(chat.membership.joined_at) }) : t("export.left"), "readable", parts.join(" "));
  });
  if (!rows.length) rows.push(row(t("export.conversations"), t("export.none"), "readable"));
  return {
    id: "conversations",
    title: t("export.conversations"),
    about: t("export.theServerKnowsWhosIn"),
    rows,
  };
}

function vaultSection(raw: ApiExport): ServerDataSection {
  const { items, history_grants: grants } = raw.vault;
  return {
    id: "vault",
    title: t("export.yourVault"),
    about: t("export.yourSettingsYourChatList"),
    rows: [
      row(t("export.items"), items.count ? t("export.itemsAndSize", { count: thousands(items.count), size: bytes(items.bytes) }) : t("export.none"), "encrypted"),
      row(
        t("export.historySharedWithYou"),
        grants.count ? t("export.grants", { count: thousands(grants.count), size: bytes(grants.bytes) }) : t("export.none"),
        "encrypted",
        t("export.keysToMessagesSentBefore"),
      ),
    ],
  };
}

function filesSection(raw: ApiExport): ServerDataSection {
  const rows = raw.files.map((file) => {
    const label =
      file.id === raw.account.avatar_file ? t("export.yourProfilePicture") : file.standalone ? t("export.aPicture") : file.completed_at === null ? t("export.anUnfinishedUpload") : t("export.aFileNotSentYet");
    return row(label, bytes(file.size), "encrypted", t("export.uploaded", { when: stamp(file.created_at) }));
  });
  if (!rows.length) rows.push(row(t("export.filesThatAreYours"), t("export.none"), "readable"));
  const mib = raw.uploads.reduce((sum, upload) => sum + upload.mib, 0);
  rows.push(
    row(
      t("export.uploadedInTheLast30"),
      raw.uploads.length ? t("export.mibOnDays", { count: raw.uploads.length, mib }) : t("export.nothing"),
      "readable",
      t("export.countedInWholeMibPer"),
    ),
  );
  return {
    id: "files",
    title: t("export.files"),
    about: t("export.filesYouveUploadedThatArent"),
    rows,
  };
}

function sendingSection(raw: ApiExport): ServerDataSection {
  const issued = raw.tokens.reduce((sum, tokens) => sum + tokens.issued, 0);
  const periods = new Set(raw.tokens.map((tokens) => tokens.period));
  const last = Math.max(0, ...periods);
  return {
    id: "sending",
    title: t("export.sending"),
    about: t("export.yourDevicesAreGivenTokens"),
    rows: [
      row(
        t("export.tokensGivenToYou"),
        issued ? t("export.inSixHourSpans", { count: periods.size, issued: thousands(issued) }) : t("export.noneKept"),
        "readable",
        issued ? t("export.theCurrentSixHourPeriod", { when: stamp(last) }) : t("export.deletedOnceTheyExpire"),
      ),
    ],
  };
}

function madeSection(raw: ApiExport): ServerDataSection | null {
  const rows: ServerDataRow[] = [];
  for (const invite of raw.invites) {
    const parts = [t("export.made", { when: stamp(invite.created_at) })];
    if (invite.expires_at) parts.push(invite.expires_at > raw.exported_at ? t("export.expires", { when: stamp(invite.expires_at) }) : t("export.expired", { when: stamp(invite.expires_at) }));
    if (invite.revoked_at) parts.push(t("export.revoked", { when: stamp(invite.revoked_at) }));
    parts.push(t("export.itsCodeIsLeftOut"));
    const label = invite.grants_role === "member" ? t("export.invite") : invite.grants_role === "admin" ? t("export.inviteForAnAdmin") : t("export.inviteFor", { role: invite.grants_role });
    const used = invite.max_uses ? t("export.usesOfMax", { uses: invite.uses, max: invite.max_uses }) : t("export.uses", { uses: invite.uses });
    rows.push(row(label, used, "readable", parts.join(" ")));
  }
  for (const bot of raw.bots) {
    const parts = [t("export.made", { when: stamp(bot.created_at) })];
    if (bot.deleted_at) parts.push(t("export.deleted", { when: stamp(bot.deleted_at) }));
    else if (!bot.set_up_at) parts.push(t("export.notSetUpYet"));
    if (bot.channels.length) parts.push(t("export.givenChannels", { count: bot.channels.length }));
    parts.push(t("export.itsNamePictureAndCommands"));
    rows.push(row(`@${bot.username}`, bot.listed ? t("export.listedBot") : t("export.privateBot"), "readable", parts.join(" ")));
  }
  if (raw.admin.channels.length) rows.push(row(t("export.channelsYouMade"), String(raw.admin.channels.length), "readable", t("export.theirNamesAndTopicsAre")));
  if (raw.admin.sounds.length) rows.push(row(t("export.soundsYouAdded"), String(raw.admin.sounds.length), "readable", t("export.theirNamesAndAudioAre")));
  if (raw.admin.banned.length) rows.push(row(t("export.peopleYouBanned"), names(raw.admin.banned.map((user) => user.username)), "readable"));
  if (!rows.length) return null;
  return { id: "made", title: t("export.whatYouveMade"), about: t("export.invitesBotsChannelsAndSounds"), rows };
}

function keysSection(raw: ApiExport): ServerDataSection {
  const links = raw.key_changes.links;
  const last = links[links.length - 1];
  return {
    id: "keys",
    title: t("export.yourKeysOverTime"),
    about: t("export.eachTimeYourAccountsKeys"),
    rows: [
      row(
        t("export.keysReplaced"),
        links.length ? t("export.times", { count: thousands(links.length) }) : t("export.never"),
        "public",
        last
          ? t("export.theLastEachOneIsSigned", { when: stamp(last.created_at) })
          : t("export.thisHappensWhenADevice"),
      ),
      row(t("export.entriesInTheLogOf"), String(raw.key_changes.log_entries), "public", t("export.yourDevicesAndTheirKeys")),
    ],
  };
}

function notKeptSection(): ServerDataSection {
  const notKept = t("export.notKept");
  return {
    id: "not-kept",
    title: t("export.whatItDoesntKeep"),
    about: t("export.theseNeverReachTheServer"),
    rows: [
      row(t("export.whatYouWriteSendAnd"), notKept, "none", t("export.messagesFilesReactionsCallsAnd")),
      row(t("export.whoSentEachMessageReaction"), notKept, "none", t("export.theyreSentWithoutYourAccount")),
      row(t("export.yourPasswordAndRecoveryKey"), notKept, "none", t("export.theyNeverLeaveYourDevice")),
      row(t("export.whoYouBlockAndWhat"), notKept, "none", t("export.theyreInYourVaultEncrypted")),
      row(t("export.whatYouSearchFor"), notKept, "none", t("export.searchRunsOnYourDevice")),
      row(t("export.whoReportsSomeone"), notKept, "none", t("export.aReportOnlyRecordsWho")),
      row(
        t("export.yourIpAddress"),
        t("export.notStored"),
        "none",
        t("export.theServerSeesItWith"),
      ),
    ],
  };
}
