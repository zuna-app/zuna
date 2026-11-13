// What a server says it keeps about an account, put in plain words (export.ts): every kind of
// row each section can have, from an export made by hand, as the e2e test's real one only has
// what a fresh account does. No server takes part.

import { describe, expect, it } from "vitest";
import type { ApiExport, ApiExportConversation, ApiExportDevice } from "../src/api";
import { bytes, count, describeExport, stamp, type ExportContext } from "../src/export";
import type { ServerDataExport } from "../src/types";

/** A moment in this device's time, as stamp() shows it. */
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

const SELF = "u-self";

function device(id: string, change: Partial<ApiExportDevice> = {}): ApiExportDevice {
  return {
    id,
    created_at: at(1),
    last_seen_at: at(2),
    revoked_at: null,
    signature_key: "AAAA",
    certificate: "AAAA",
    seal_key: null,
    seal_generation: null,
    seal_proof: null,
    enroll_proof: null,
    sessions: [],
    key_packages: { count: 0, bytes: 0 },
    welcomes: { count: 0, bytes: 0 },
    account_key: null,
    push: null,
    ...change,
  };
}

function chat(id: string, change: Partial<ApiExportConversation> = {}): ApiExportConversation {
  return {
    id,
    kind: "group",
    created_by: "u-other",
    created_at: at(3),
    epoch: 1,
    changes: 0,
    history_visible: false,
    meta_size: 0,
    membership: { role: "member", joined_at: at(3, 9, 30), visible_from_seq: 0, read_state_size: 0, proof_size: 0, history_wanted: false },
    member_count: 1,
    members: [{ id: SELF, username: "ada", role: "member", joined_at: at(3) }],
    messages: { count: 0, bytes: 0, deleted: 0, first: null, last: null },
    by_you: { count: 0, last: null },
    to_you: { count: 0, last: null },
    ...change,
  };
}

function raw(change: Partial<ApiExport> = {}): ApiExport {
  return {
    exported_at: at(12, 17, 5),
    account: {
      id: SELF,
      username: "ada",
      role: "admin",
      created_at: at(1, 8, 0),
      updated_at: at(1),
      last_seen_at: null,
      hide_last_seen: false,
      banned_at: null,
      banned_by: null,
      deleted_at: null,
      key_generation: 1,
      // Base64 of 3, 2 and 1 bytes.
      identity_key: "AAAA",
      identity_head: "AAA=",
      hpke_key: "AA==",
      hpke_key_sig: null,
      profile: null,
      profile_sig: "",
      avatar_file: null,
      vault_core: "AAAAAAAA",
      stored_bytes: 1000,
      commit_bytes: 24,
    },
    sign_in: { kdf: { salt: "", memory: 65536, iterations: 3, parallelism: 1 }, auth_hash_size: 32, recovery_hash_size: 32, slots: [], attempts: null },
    devices: [],
    signing_in: [],
    conversations: [],
    vault: { items: { count: 0, bytes: 0 }, history_grants: { count: 0, bytes: 0 } },
    files: [],
    uploads: [],
    tokens: [],
    invites: [],
    bots: [],
    admin: { channels: [], sounds: [], banned: [] },
    key_changes: { links: [], log_entries: 0 },
    ...change,
  };
}

const context = (change: Partial<ExportContext> = {}): ExportContext => ({
  deviceId: "d-this",
  deviceName: () => undefined,
  conversationName: () => undefined,
  serverUrl: "https://chat.example.com:8443",
  ...change,
});

const section = (exported: ServerDataExport, id: string) => exported.sections.find((item) => item.id === id);
const rowOf = (exported: ServerDataExport, id: string, label: string) => section(exported, id)?.rows.find((row) => row.label === label);

describe("the server's export, in plain words", () => {
  it("writes sizes, counts and moments the same in every host, without Intl", () => {
    expect([0, 1, 2, 1023].map(bytes)).toEqual(["0 bytes", "1 byte", "2 bytes", "1023 bytes"]);
    expect([1024, 1536, 10 * 1024, 5 * 1024 ** 2, 3.25 * 1024 ** 3].map(bytes)).toEqual(["1 KB", "1.5 KB", "10 KB", "5 MB", "3.3 GB"]);
    // Past terabytes it stays in them.
    expect(bytes(2048 * 1024 ** 4)).toBe("2048 TB");
    expect(count(1, "day")).toBe("1 day");
    expect(count(1234567, "pass", "passes")).toBe("1,234,567 passes");
    expect(stamp(at(5, 7, 3))).toBe("2026-11-05 07:03");
  });

  it("names its file after the server, the account and the day, and keeps the answer as it came", () => {
    const exported = describeExport(raw(), context());
    expect(exported.fileName).toBe("zuna-chat.example.com-8443-ada-2026-11-12.json");
    expect(JSON.parse(exported.json)).toEqual(raw());
    // An address that doesn't parse, and an account with no username, still name one.
    const nameless = raw({ account: { ...raw().account, username: "" } });
    expect(describeExport(nameless, context({ serverUrl: "not a url" })).fileName).toBe("zuna-server-u-self-2026-11-12.json");
  });

  it("says what it keeps of the account, banned or not, with its picture or not", () => {
    const plain = describeExport(raw(), context());
    expect(rowOf(plain, "account", "Role")?.value).toBe("Admin");
    expect(rowOf(plain, "account", "Created")?.value).toBe("2026-11-01 08:00");
    expect(rowOf(plain, "account", "Last online")).toEqual({ label: "Last online", value: "Not yet", kind: "readable" });
    expect(rowOf(plain, "account", "Banned")).toBeUndefined();
    expect(rowOf(plain, "account", "Profile picture")).toBeUndefined();
    expect(rowOf(plain, "account", "Profile")?.value).toBe("0 bytes");
    expect(rowOf(plain, "account", "Your account's keys")?.value).toBe("6 bytes");
    expect(rowOf(plain, "account", "Your public keys")?.value).toBe("6 bytes");
    expect(rowOf(plain, "account", "Storage counted")?.value).toBe("1 KB");

    const account = { ...raw().account, last_seen_at: at(11, 23, 59), hide_last_seen: true, banned_at: at(10), avatar_file: "f-avatar" };
    const banned = describeExport(raw({ account, files: [{ id: "f-avatar", size: 2048, created_at: at(4), completed_at: at(4), attached_at: null, standalone: true }] }), context());
    expect(rowOf(banned, "account", "Last online")?.value).toBe("2026-11-11 23:59");
    expect(rowOf(banned, "account", "Last online")?.note).toMatch(/hide when you're online/);
    expect(rowOf(banned, "account", "Banned")?.value).toBe("2026-11-10 12:00");
    expect(rowOf(banned, "account", "Profile picture")).toMatchObject({ value: "2 KB", kind: "encrypted" });
    expect(rowOf(banned, "files", "Your profile picture")?.value).toBe("2 KB");
    // A picture whose file the export doesn't list is still said to be kept.
    expect(rowOf(describeExport(raw({ account }), context()), "account", "Profile picture")?.value).toBe("Kept");
  });

  it("names each sealed copy of the account key, the password's cost, and attempts to sign in", () => {
    const sign_in = {
      ...raw().sign_in,
      slots: [
        { kind: "password", size: 120 },
        { kind: "recovery", size: 121 },
        { kind: "passkey", size: 122 },
      ],
      attempts: { attempts: 4, until: at(13), seen_at: at(12, 9, 15) },
    };
    const exported = describeExport(raw({ sign_in }), context());
    const rows = section(exported, "sign-in")!.rows;
    expect(rows.map((row) => row.label)).toEqual([
      "Password check",
      "Recovery key check",
      "Keys sealed to your password",
      "Keys sealed to your recovery key",
      "Keys sealed to “passkey”",
      "How your password is stretched",
      "Sign-in attempts",
    ]);
    expect(rows[2]!.note).toMatch(/only your password opens it/);
    expect(rows[3]!.note).toMatch(/only your recovery key opens it/);
    expect(rows[5]!.value).toBe("Argon2id, 64 MiB, 3 passes");
    expect(rows[6]!.value).toBe("4, the last 2026-11-12 09:15");
    expect(section(describeExport(raw(), context()), "sign-in")!.rows.map((row) => row.label)).not.toContain("Sign-in attempts");
  });

  it("lists this device first, then the others by when they were used, then the removed ones", () => {
    const devices = [
      device("d-gone", { revoked_at: at(6), last_seen_at: at(9) }),
      device("d-old", { last_seen_at: at(3) }),
      device("d-this", {
        last_seen_at: at(4),
        sessions: [
          { created_at: at(1), last_used_at: at(4, 10) },
          { created_at: at(1), last_used_at: at(5, 11) },
        ],
        key_packages: { count: 100, bytes: 1024 * 1024 },
        welcomes: { count: 1, bytes: 300 },
        account_key: { generation: 1, size: 200 },
        push: { relay: "https://push.example.com/relay", handle_size: 0, call_handle_size: 0, key: null, registration: "", muted: { a: 1, b: 2 }, filters: true, notified: ["g1"], updated_at: at(4) },
      }),
      device("d-new", { last_seen_at: at(8), push: { relay: "not a url", handle_size: 0, call_handle_size: 0, key: null, registration: "", muted: null, filters: false, notified: [], updated_at: at(4) } }),
    ];
    const names: Record<string, string> = { "d-this": "Laptop", "d-new": "Phone" };
    const exported = describeExport(raw({ devices, signing_in: [{ created_at: at(12), last_used_at: at(12) }] }), context({ deviceName: (id) => names[id] }));
    const rows = section(exported, "devices")!.rows;
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["Laptop (this device)", "Last used 2026-11-04 12:00"],
      ["Phone", "Last used 2026-11-08 12:00"],
      ["A device", "Last used 2026-11-03 12:00"],
      ["A removed device", "Removed 2026-11-06 12:00"],
      ["Notifications for Laptop (this device)", "Through push.example.com"],
      ["Notifications for Phone", "Through not a url"],
      ["Signing in", "1 session"],
    ]);
    expect(rows[0]!.note).toBe(
      "Signed in 2026-11-01 12:00. 2 sessions, the last used 2026-11-05 11:00. Its public keys, which others encrypt to it with and check what it signs against. " +
        "100 keys for others to add it to conversations with, 1 MB. 1 invitation to conversations waiting for it, 300 bytes, encrypted. Your account key sealed to it, 200 bytes.",
    );
    // A removed device keeps no keys to speak of.
    expect(rows[3]!.note).toBe("Signed in 2026-11-01 12:00.");
    expect(rows[4]!.note).toBe(
      "The relay's handles for it are left out, as they'd let anyone wake it. 2 chats muted there, so as not to be pushed. Notified about 1 chat not read since. It hides what it shouldn't show itself, so it's pushed for everything.",
    );
    expect(rows[5]!.note).toBe("The relay's handles for it are left out, as they'd let anyone wake it.");
    // This device, unnamed here.
    const unnamed = describeExport(raw({ devices: [device("d-this")] }), context());
    expect(section(unnamed, "devices")!.rows[0]!.label).toBe("This device");
  });

  it("names each conversation by who's in it, never by what it's called, which only devices know", () => {
    const member = (id: string, username: string) => ({ id, username, role: "member", joined_at: at(3) });
    const conversations = [
      chat("c-saved", { kind: "dm", dm_key: `${SELF}:${SELF}`, messages: { count: 1, bytes: 10, deleted: 0, first: at(5), last: at(5) } }),
      chat("c-bob", {
        kind: "dm",
        dm_key: `u-bob:${SELF}`,
        members: [member(SELF, "ada"), member("u-bob", "bob")],
        messages: { count: 2, bytes: 4096, deleted: 0, first: at(6), last: at(9, 18, 30) },
        created_by: SELF,
      }),
      chat("c-left", { kind: "dm", dm_key: `${SELF}:u-gone`, membership: null }),
      // Made long ago, but no message: sorted by when it was made.
      chat("c-lonely-dm", { kind: "dm", created_at: at(2) }),
      chat("c-channel", { kind: "channel", member_count: 40, meta_size: 300 }),
      chat("c-group", {
        members: [member(SELF, "ada"), member("u-1", "cy"), member("u-2", ""), member("u-3", "di"), member("u-4", "ed")],
        by_you: { count: 3, last: at(7) },
        to_you: { count: 1, last: at(7) },
        messages: { count: 5, bytes: 50, deleted: 0, first: at(7), last: null },
      }),
      chat("c-pair", { members: [member(SELF, "ada"), member("u-1", "cy"), member("u-2", "")], by_you: { count: 1, last: null } }),
      chat("c-alone"),
    ];
    const names: Record<string, string> = { "c-bob": "Bob" };
    const exported = describeExport(raw({ conversations }), context({ conversationName: (id) => names[id] }));
    const rows = section(exported, "conversations")!.rows;
    const byLabel = (label: string) => rows.find((row) => row.label === label)!;
    expect(rows[0]!.label).toBe("Direct message with @bob");
    expect(byLabel("Direct message with @bob").note).toBe("On your devices: “Bob”. 2 messages, 4 KB encrypted, the last 2026-11-09 18:30. You started it.");
    expect(byLabel("Direct message with @bob").value).toBe("Joined 2026-11-03 09:30");
    expect(rows.filter((row) => row.label === "Your saved messages")).toHaveLength(2);
    expect(byLabel("Direct message with someone who left it")).toMatchObject({ value: "Left", note: "No messages kept." });
    expect(byLabel("Channel with 40 members").note).toBe("No messages kept. Its name, picture and description: 300 bytes, encrypted.");
    expect(byLabel("Group with @cy, a deleted account and 2 more").note).toBe(
      "5 messages, 50 bytes encrypted, the last 2026-11-03 12:00. 3 changes to who's in it or its keys by you, the last 2026-11-07 12:00. 1 change about you.",
    );
    expect(byLabel("Group with @cy and a deleted account").note).toBe("No messages kept. 1 change to who's in it or its keys by you, the last 2026-11-03 12:00.");
    expect(byLabel("Group with only you")).toBeDefined();
    expect(rows.at(-1)!.label).toBe("Your saved messages");

    const none = describeExport(raw(), context());
    expect(section(none, "conversations")!.rows).toEqual([{ label: "Conversations", value: "None", kind: "readable" }]);
  });

  it("counts the vault, the files, the uploads and the tokens, or says there are none", () => {
    const none = describeExport(raw(), context());
    expect(section(none, "vault")!.rows.map((row) => row.value)).toEqual(["None", "None"]);
    expect(section(none, "files")!.rows.map((row) => [row.label, row.value])).toEqual([
      ["Files that are yours", "None"],
      ["Uploaded in the last 30 days", "Nothing"],
    ]);
    expect(rowOf(none, "sending", "Tokens given to you")).toMatchObject({ value: "None kept", note: "Forgotten once they can't be spent." });

    const files = [
      { id: "f-1", size: 10, created_at: at(4), completed_at: at(4), attached_at: null, standalone: true },
      { id: "f-2", size: 20, created_at: at(5), completed_at: null, attached_at: null, standalone: false },
      { id: "f-3", size: 30, created_at: at(6), completed_at: at(6), attached_at: null, standalone: false },
    ];
    const some = describeExport(
      raw({
        vault: { items: { count: 12, bytes: 2048 }, history_grants: { count: 1, bytes: 100 } },
        files,
        uploads: [
          { day: 1, mib: 3 },
          { day: 2, mib: 4 },
        ],
        tokens: [
          { period: at(11, 6), size: "100", issued: 1500 },
          { period: at(12, 0), size: "100", issued: 200 },
          { period: at(12, 0), size: "10", issued: 5 },
        ],
      }),
      context(),
    );
    expect(section(some, "vault")!.rows.map((row) => row.value)).toEqual(["12 items, 2 KB", "1 grant, 100 bytes"]);
    expect(section(some, "files")!.rows.map((row) => [row.label, row.value])).toEqual([
      ["A picture", "10 bytes"],
      ["An unfinished upload", "20 bytes"],
      ["A file not sent yet", "30 bytes"],
      ["Uploaded in the last 30 days", "7 MiB on 2 days"],
    ]);
    expect(section(some, "files")!.rows[0]!.note).toBe("Uploaded 2026-11-04 12:00.");
    expect(rowOf(some, "sending", "Tokens given to you")).toMatchObject({ value: "1,705 in 2 six-hour spans", note: "The last six hours began 2026-11-12 00:00. Forgotten once they can't be spent." });
  });

  it("lists invites, bots, channels, sounds and bans made, and leaves the section out when there are none", () => {
    expect(section(describeExport(raw(), context()), "made")).toBeUndefined();
    const exported = describeExport(
      raw({
        invites: [
          { created_at: at(2), grants_role: "member", max_uses: 0, uses: 3, expires_at: null, revoked_at: null },
          { created_at: at(3), grants_role: "admin", max_uses: 5, uses: 1, expires_at: at(20), revoked_at: null },
          { created_at: at(4), grants_role: "moderator", max_uses: 1, uses: 0, expires_at: at(5), revoked_at: at(4, 13) },
        ],
        bots: [
          { id: "b1", username: "helper", listed: true, add_policy: "owner", files: false, created_at: at(5), set_up_at: at(5), deleted_at: null, channels: ["c1", "c2"] },
          { id: "b2", username: "fresh", listed: false, add_policy: "owner", files: false, created_at: at(6), set_up_at: null, deleted_at: null, channels: [] },
          { id: "b3", username: "old", listed: false, add_policy: "owner", files: false, created_at: at(7), set_up_at: null, deleted_at: at(8), channels: [] },
        ],
        admin: {
          channels: [{ id: "c1", created_at: at(2) }],
          sounds: [
            { id: "s1", created_at: at(2) },
            { id: "s2", created_at: at(2) },
          ],
          banned: [
            { id: "u-x", username: "spam", banned_at: at(2) },
            { id: "u-y", username: "", banned_at: at(2) },
          ],
        },
      }),
      context(),
    );
    const rows = section(exported, "made")!.rows;
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["Invite", "Used 3"],
      ["Invite for an admin", "Used 1 of 5"],
      ["Invite for moderator", "Used 0 of 1"],
      ["@helper", "Listed bot"],
      ["@fresh", "Private bot"],
      ["@old", "Private bot"],
      ["Channels you made", "1"],
      ["Sounds you added", "2"],
      ["People you banned", "@spam and a deleted account"],
    ]);
    expect(rows[0]!.note).toBe("Made 2026-11-02 12:00. Its code is left out, as anyone with it could join.");
    expect(rows[1]!.note).toBe("Made 2026-11-03 12:00. Expires 2026-11-20 12:00. Its code is left out, as anyone with it could join.");
    expect(rows[2]!.note).toBe("Made 2026-11-04 12:00. Expired 2026-11-05 12:00. Revoked 2026-11-04 13:00. Its code is left out, as anyone with it could join.");
    expect(rows[3]!.note).toBe("Made 2026-11-05 12:00. Given 2 channels. Its name, picture and commands are encrypted, in its own profile.");
    expect(rows[4]!.note).toBe("Made 2026-11-06 12:00. Not set up yet. Its name, picture and commands are encrypted, in its own profile.");
    expect(rows[5]!.note).toBe("Made 2026-11-07 12:00. Deleted 2026-11-08 12:00. Its name, picture and commands are encrypted, in its own profile.");
  });

  it("says when the account's keys were last replaced, and what it never keeps", () => {
    const never = describeExport(raw(), context());
    expect(rowOf(never, "keys", "Keys replaced")).toMatchObject({ value: "Never", note: "As happens when a device is removed or your password changes." });
    const replaced = describeExport(
      raw({
        key_changes: {
          links: [
            { generation: 2, created_at: at(4) },
            { generation: 3, created_at: at(9, 8, 45) },
          ],
          log_entries: 17,
        },
      }),
      context(),
    );
    expect(rowOf(replaced, "keys", "Keys replaced")?.value).toBe("2 times");
    expect(rowOf(replaced, "keys", "Keys replaced")?.note).toMatch(/^The last 2026-11-09 08:45\./);
    expect(rowOf(replaced, "keys", "Entries in the log of keys")?.value).toBe("17");
    expect(section(replaced, "not-kept")!.rows.every((row) => row.kind === "none")).toBe(true);
    expect(replaced.sections.map((item) => item.id)).toEqual(["account", "sign-in", "devices", "conversations", "vault", "files", "sending", "keys", "not-kept"]);
  });
});
