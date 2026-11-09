// What zuna-bot keeps beside the bot's account: the table from Zuna's IDs to the numbers
// Telegram's API speaks in, the updates waiting to be taken, and where they go.
//
// Telegram's IDs are numbers and Zuna's aren't, so each person, chat and message gets a
// number the first time the bot's code hears of it, and keeps it. A direct message's
// chat has its person's number, as on Telegram, and a group's or channel's is negative.

import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export interface StoredMessage {
  number: number;
  groupId: string;
  id: string;
  editedAt: number | null;
}

/** A file a message held, as the app needs it to fetch and open it. */
export interface StoredFile {
  fileId: string;
  key: string;
  prefix: string;
  chunks: number;
  mime: string;
  name: string;
  size: number;
}

export class BotStore {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS chats (n INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, joined INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (
        n INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        id TEXT NOT NULL,
        edited_at INTEGER,
        told INTEGER NOT NULL DEFAULT 0,
        UNIQUE (group_id, id)
      );
      CREATE TABLE IF NOT EXISTS updates (n INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, ref TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  get(key: string): string | null {
    return (this.db.prepare("SELECT v FROM meta WHERE k = ?").get(key) as { v: string } | undefined)?.v ?? null;
  }

  set(key: string, value: string | null): void {
    if (value === null) this.db.prepare("DELETE FROM meta WHERE k = ?").run(key);
    else this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(key, value);
  }

  // --- People and chats ---

  /** The number a person goes by, given the first time they're asked for. */
  userNumber(id: string): number {
    this.db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)").run(id);
    return Number((this.db.prepare("SELECT n FROM users WHERE id = ?").get(id) as { n: number }).n);
  }

  userId(number: number): string | null {
    return (this.db.prepare("SELECT id FROM users WHERE n = ?").get(number) as { id: string } | undefined)?.id ?? null;
  }

  /** A group's or channel's number, which is negative, as Telegram's are. */
  chatNumber(groupId: string): number {
    this.db.prepare("INSERT OR IGNORE INTO chats(id) VALUES(?)").run(groupId);
    return -Number((this.db.prepare("SELECT n FROM chats WHERE id = ?").get(groupId) as { n: number }).n);
  }

  chatGroup(number: number): string | null {
    return (this.db.prepare("SELECT id FROM chats WHERE n = ?").get(-number) as { id: string } | undefined)?.id ?? null;
  }

  /** The groups and channels the bot's code was told it's in. */
  joinedChats(): string[] {
    return (this.db.prepare("SELECT id FROM chats WHERE joined = 1").all() as { id: string }[]).map((row) => row.id);
  }

  setJoined(groupId: string, joined: boolean): void {
    this.chatNumber(groupId);
    this.db.prepare("UPDATE chats SET joined = ? WHERE id = ?").run(joined ? 1 : 0, groupId);
  }

  // --- Messages ---

  /** The number a message goes by, given the first time it's asked for. */
  messageNumber(groupId: string, id: string): number {
    this.db.prepare("INSERT OR IGNORE INTO messages(group_id, id) VALUES(?, ?)").run(groupId, id);
    return Number((this.db.prepare("SELECT n FROM messages WHERE group_id = ? AND id = ?").get(groupId, id) as { n: number }).n);
  }

  message(number: number): StoredMessage | null {
    const row = this.db.prepare("SELECT n, group_id, id, edited_at FROM messages WHERE n = ?").get(number) as { n: number; group_id: string; id: string; edited_at: number | null } | undefined;
    return row ? { number: Number(row.n), groupId: row.group_id, id: row.id, editedAt: row.edited_at === null ? null : Number(row.edited_at) } : null;
  }

  /** Whether the bot's code was told of a message, and the edit it was last told of. */
  told(groupId: string, id: string): { told: boolean; editedAt: number | null } {
    const row = this.db.prepare("SELECT told, edited_at FROM messages WHERE group_id = ? AND id = ?").get(groupId, id) as { told: number; edited_at: number | null } | undefined;
    return { told: !!row && Number(row.told) !== 0, editedAt: row?.edited_at == null ? null : Number(row.edited_at) };
  }

  setTold(groupId: string, id: string, editedAt: number | null): void {
    this.messageNumber(groupId, id);
    this.db.prepare("UPDATE messages SET told = 1, edited_at = ? WHERE group_id = ? AND id = ?").run(editedAt, groupId, id);
  }

  // --- Updates ---

  /** Keeps an update until it's taken, and gives it the next number. */
  pushUpdate(body: Record<string, unknown>): number {
    return Number(this.db.prepare("INSERT INTO updates(body) VALUES(?)").run(JSON.stringify(body)).lastInsertRowid);
  }

  /** The updates from a number on, oldest first. */
  updates(from: number, limit: number): Record<string, unknown>[] {
    const rows = this.db.prepare("SELECT n, body FROM updates WHERE n >= ? ORDER BY n LIMIT ?").all(from, limit) as { n: number; body: string }[];
    return rows.map((row) => ({ update_id: Number(row.n), ...(JSON.parse(row.body) as Record<string, unknown>) }));
  }

  /** The last updates there are, oldest first, for a negative offset. */
  lastUpdates(count: number): Record<string, unknown>[] {
    const rows = this.db.prepare("SELECT n, body FROM updates ORDER BY n DESC LIMIT ?").all(count) as { n: number; body: string }[];
    return rows.reverse().map((row) => ({ update_id: Number(row.n), ...(JSON.parse(row.body) as Record<string, unknown>) }));
  }

  /** Lets go of the updates below a number, which the bot's code has taken. */
  confirm(below: number): void {
    this.db.prepare("DELETE FROM updates WHERE n < ?").run(below);
  }

  dropUpdates(): void {
    this.db.exec("DELETE FROM updates");
  }

  pendingUpdates(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM updates").get() as { n: number }).n);
  }

  // --- Files ---

  rememberFile(file: StoredFile): void {
    this.db.prepare("INSERT INTO files(id, ref) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET ref = excluded.ref").run(file.fileId, JSON.stringify(file));
  }

  file(id: string): StoredFile | null {
    const row = this.db.prepare("SELECT ref FROM files WHERE id = ?").get(id) as { ref: string } | undefined;
    return row ? (JSON.parse(row.ref) as StoredFile) : null;
  }
}
