// What the tests of the log of keys share: what a malicious server writes to its own log, which
// it can, holding the log's key, and what it can't help showing when it does.

import * as wasm from "@zuna/crypto";
import { execFileSync } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import { concat, fromBase64, toBase64, utf8 } from "../src/encoding";
import { Frontier, bodyHash, headInput, leafHash, nameTag, userTag, type LogHead } from "../src/transparency";
import { withServerDatabase as securityDatabase } from "./security-setup";
import { buildServer } from "./server-binary";

type Db = InstanceType<typeof DatabaseSync>;

/** How these reach the server's database: the security tests' server's, unless a test file says another. */
let withServerDatabase: <T>(use: (db: Db) => T) => T = securityDatabase;

export function useLogDatabase(open: () => Db): void {
  withServerDatabase = <T,>(use: (db: Db) => T): T => {
    const db = open();
    try {
      return use(db);
    } finally {
      db.close();
    }
  };
}

const setting = (db: Db, key: string): string => (db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string }).value;

/** The log as the server keeps it: its key's seed, its era and its tree. */
export function serverLog(db: Db): { seed: Uint8Array; era: number; frontier: Frontier } {
  const size = Number(setting(db, "log_size"));
  const roots = fromBase64(setting(db, "log_frontier"));
  const frontier = new Frontier(size, Array.from({ length: roots.length / 32 }, (_, i) => roots.slice(i * 32, i * 32 + 32)));
  return { seed: fromBase64(setting(db, "log_key")), era: Number(setting(db, "log_era")), frontier };
}

function saveFrontier(db: Db, frontier: Frontier): void {
  const set = db.prepare("UPDATE settings SET value = ? WHERE key = ?");
  set.run(String(frontier.size), "log_size");
  set.run(toBase64(concat(...frontier.roots)), "log_frontier");
}

/**
 * Appends an entry as the server's own code would, or with whatever it likes in it: the record's
 * user tag for `tagFor` rather than the body's account, say. Returns its place.
 */
export function appendToLog(body: Record<string, unknown> & { user: string }, options: { tagFor?: string; username?: string } = {}): number {
  return withServerDatabase((db) => {
    const { era, frontier } = serverLog(db);
    const bytes = utf8(JSON.stringify(body));
    const nonce = wasm.randomBytes(16);
    const name = options.username ?? (body.t === "account" ? String(body.username) : null);
    const record = concat(nonce, userTag(options.tagFor ?? body.user, nonce), name !== null ? nameTag(name, nonce) : wasm.randomBytes(16), bodyHash(nonce, bytes));
    const idx = frontier.size;
    frontier.append(leafHash(record));
    db.prepare("INSERT INTO log_entries(era, idx, record, body, user_id, root) VALUES(?, ?, ?, ?, ?, ?)").run(era, idx, record, bytes, body.user, frontier.root());
    saveFrontier(db, frontier);
    return idx;
  });
}

/** Takes the log back to `size` entries, as a server restored from an older copy would be. Returns what it took off, to put back. */
export function truncateLog(size: number): { record: Uint8Array; body: Uint8Array; user_id: string }[] {
  return withServerDatabase((db) => {
    const { era } = serverLog(db);
    const removed = db.prepare("SELECT record, body, user_id FROM log_entries WHERE era = ? AND idx >= ? ORDER BY idx").all(era, size) as { record: Uint8Array; body: Uint8Array; user_id: string }[];
    db.prepare("DELETE FROM log_entries WHERE era = ? AND idx >= ?").run(era, size);
    const frontier = new Frontier();
    for (const row of db.prepare("SELECT record FROM log_entries WHERE era = ? ORDER BY idx").all(era) as { record: Uint8Array }[]) frontier.append(leafHash(new Uint8Array(row.record)));
    saveFrontier(db, frontier);
    return removed.map((row) => ({ record: new Uint8Array(row.record), body: new Uint8Array(row.body), user_id: row.user_id }));
  });
}

/** Puts back what truncateLog took off, record for record. */
export function restoreLog(entries: { record: Uint8Array; body: Uint8Array; user_id: string }[]): void {
  withServerDatabase((db) => {
    const { era, frontier } = serverLog(db);
    for (const entry of entries) {
      const idx = frontier.size;
      frontier.append(leafHash(entry.record));
      db.prepare("INSERT INTO log_entries(era, idx, record, body, user_id, root) VALUES(?, ?, ?, ?, ?, ?)").run(era, idx, entry.record, entry.body, entry.user_id, frontier.root());
    }
    saveFrontier(db, frontier);
  });
}

/** How long the server's log is now. */
export const logSize = (): number => withServerDatabase((db) => serverLog(db).frontier.size);

/** The server's head now, signed with its log key, as it would sign one. */
export function serverHead(): LogHead {
  return withServerDatabase((db) => {
    const { seed, era, frontier } = serverLog(db);
    const root = frontier.root();
    return { era, size: frontier.size, root, sig: wasm.sign(seed, headInput(era, frontier.size, root)) };
  });
}

/** The server's log key's seed, for a test that signs a second log with it. */
export const logSeed = (): Uint8Array => withServerDatabase((db) => serverLog(db).seed);

/** An entry's body as the server writes one, with bytes as base64. */
export const b64 = (bytes: Uint8Array): string => toBase64(bytes);

/** The hash an entry holds of something. */
export const entryOf = (data: Uint8Array): string => toBase64(wasm.sha256(data));

/** An entry as the server would write one, kept nowhere. */
export function makeEntry(body: Record<string, unknown> & { user: string }): { record: Uint8Array; body: Uint8Array } {
  const bytes = utf8(JSON.stringify(body));
  const nonce = wasm.randomBytes(16);
  const name = body.t === "account" ? String(body.username) : null;
  return { record: concat(nonce, userTag(body.user, nonce), name !== null ? nameTag(name, nonce) : wasm.randomBytes(16), bodyHash(nonce, bytes)), body: bytes };
}

/** An account nobody uses, which fits every rule, for a log to grow by. */
export const harmless = (): Record<string, unknown> & { user: string } => {
  const user = wasm.randomBytes(16);
  const id = Array.from(user, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { v: 1, t: "account", user: id, username: `nobody-${id.slice(0, 12)}`, root: b64(wasm.randomBytes(32)), hpke: b64(wasm.randomBytes(32)), hpke_sig: b64(wasm.randomBytes(64)) };
};

/** Every entry in the server's log now, with its body. */
export function serverEntries(): { record: Uint8Array; body: Uint8Array }[] {
  return withServerDatabase((db) => {
    const { era } = serverLog(db);
    return (db.prepare("SELECT record, body FROM log_entries WHERE era = ? ORDER BY idx").all(era) as { record: Uint8Array; body: Uint8Array }[]).map((row) => ({
      record: new Uint8Array(row.record),
      body: new Uint8Array(row.body),
    }));
  });
}

/**
 * A second log, which a server could answer one person with in place of its own, signed with its
 * log key as its own is: what `Api.log` gives, from these entries.
 */
export function secondLog(entries: { record: Uint8Array; body: Uint8Array }[]) {
  const { seed, era } = withServerDatabase((db) => serverLog(db));
  return async (_era: number, after: number, limit: number) => {
    const start = Math.min(Math.max(after, 0), entries.length);
    const slice = entries.slice(start, start + limit);
    const tree = new Frontier();
    for (const entry of entries.slice(0, start + slice.length)) tree.append(leafHash(entry.record));
    const root = tree.root();
    return {
      era,
      size: entries.length,
      head: { era, size: tree.size, root: b64(root), sig: b64(wasm.sign(seed, headInput(era, tree.size, root))) },
      records: slice.map((entry, i) => ({ idx: start + i, record: b64(entry.record), body: b64(entry.body) })),
    };
  };
}

/** Has the server's owner start the log again, with zuna-server's flag, as after restoring a backup. */
export function startNewEra(dir: string): void {
  execFileSync(process.env.ZUNA_TEST_SERVER_BINARY ?? buildServer(), ["--data", dir, "--new-log-era", "--push-relays", "off"], { stdio: "pipe" });
}
