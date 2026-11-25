// What zuna-bot keeps beside the bot's account: the table from Zuna's IDs to the numbers
// Telegram's API speaks in, the updates waiting to be taken, and where they go.
//
// Telegram's IDs are numbers and Zuna's aren't, so each person, chat and message gets a
// number the first time the bot's code hears of it, and keeps it. A direct message's
// chat has its person's number, as on Telegram, and a group's or channel's is negative.

import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
type Statement = ReturnType<InstanceType<typeof DatabaseSync>["prepare"]>;

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
  private readonly userIdToNum = new Map<string, number>();
  private readonly numToUserId = new Map<number, string>();
  private readonly groupIdToNum = new Map<string, number>();
  private readonly numToGroupId = new Map<number, string>();

  private readonly stmtMetaGet: Statement;
  private readonly stmtMetaSet: Statement;
  private readonly stmtMetaDelete: Statement;
  private readonly stmtUserInsert: Statement;
  private readonly stmtUserById: Statement;
  private readonly stmtUserByNum: Statement;
  private readonly stmtChatInsert: Statement;
  private readonly stmtChatById: Statement;
  private readonly stmtChatByNum: Statement;
  private readonly stmtJoinedChats: Statement;
  private readonly stmtChatSetJoined: Statement;
  private readonly stmtMsgInsert: Statement;
  private readonly stmtMsgByKey: Statement;
  private readonly stmtMsgByNum: Statement;
  private readonly stmtMsgTold: Statement;
  private readonly stmtMsgSetTold: Statement;
  private readonly stmtUpdatePush: Statement;
  private readonly stmtUpdatesFrom: Statement;
  private readonly stmtUpdatesLast: Statement;
  private readonly stmtUpdatesConfirm: Statement;
  private readonly stmtUpdatesCount: Statement;
  private readonly stmtFileSet: Statement;
  private readonly stmtFileGet: Statement;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
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
    this.stmtMetaGet = this.db.prepare("SELECT v FROM meta WHERE k = ?");
    this.stmtMetaSet = this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    this.stmtMetaDelete = this.db.prepare("DELETE FROM meta WHERE k = ?");
    this.stmtUserInsert = this.db.prepare("INSERT OR IGNORE INTO users(id) VALUES(?)");
    this.stmtUserById = this.db.prepare("SELECT n FROM users WHERE id = ?");
    this.stmtUserByNum = this.db.prepare("SELECT id FROM users WHERE n = ?");
    this.stmtChatInsert = this.db.prepare("INSERT OR IGNORE INTO chats(id) VALUES(?)");
    this.stmtChatById = this.db.prepare("SELECT n FROM chats WHERE id = ?");
    this.stmtChatByNum = this.db.prepare("SELECT id FROM chats WHERE n = ?");
    this.stmtJoinedChats = this.db.prepare("SELECT id FROM chats WHERE joined = 1");
    this.stmtChatSetJoined = this.db.prepare("INSERT INTO chats(id, joined) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET joined = excluded.joined RETURNING n");
    this.stmtMsgInsert = this.db.prepare("INSERT OR IGNORE INTO messages(group_id, id) VALUES(?, ?)");
    this.stmtMsgByKey = this.db.prepare("SELECT n FROM messages WHERE group_id = ? AND id = ?");
    this.stmtMsgByNum = this.db.prepare("SELECT n, group_id, id, edited_at FROM messages WHERE n = ?");
    this.stmtMsgTold = this.db.prepare("SELECT told, edited_at FROM messages WHERE group_id = ? AND id = ?");
    this.stmtMsgSetTold = this.db.prepare("INSERT INTO messages(group_id, id, edited_at, told) VALUES(?, ?, ?, 1) ON CONFLICT(group_id, id) DO UPDATE SET told = 1, edited_at = excluded.edited_at");
    this.stmtUpdatePush = this.db.prepare("INSERT INTO updates(body) VALUES(?)");
    this.stmtUpdatesFrom = this.db.prepare("SELECT n, body FROM updates WHERE n >= ? ORDER BY n LIMIT ?");
    this.stmtUpdatesLast = this.db.prepare("SELECT n, body FROM updates ORDER BY n DESC LIMIT ?");
    this.stmtUpdatesConfirm = this.db.prepare("DELETE FROM updates WHERE n < ?");
    this.stmtUpdatesCount = this.db.prepare("SELECT COUNT(*) AS n FROM updates");
    this.stmtFileSet = this.db.prepare("INSERT INTO files(id, ref) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET ref = excluded.ref");
    this.stmtFileGet = this.db.prepare("SELECT ref FROM files WHERE id = ?");
  }

  close(): void {
    this.db.close();
  }

  get(key: string): string | null {
    return (this.stmtMetaGet.get(key) as { v: string } | undefined)?.v ?? null;
  }

  set(key: string, value: string | null): void {
    if (value === null) this.stmtMetaDelete.run(key);
    else this.stmtMetaSet.run(key, value);
  }

  // --- People and chats ---

  /** The number a person goes by, given the first time they're asked for. */
  userNumber(id: string): number {
    const cached = this.userIdToNum.get(id);
    if (cached !== undefined) return cached;
    let row = this.stmtUserById.get(id) as { n: number } | undefined;
    if (!row) {
      this.stmtUserInsert.run(id);
      row = this.stmtUserById.get(id) as { n: number };
    }
    const n = Number(row.n);
    this.userIdToNum.set(id, n);
    this.numToUserId.set(n, id);
    return n;
  }

  userId(number: number): string | null {
    const cached = this.numToUserId.get(number);
    if (cached !== undefined) return cached;
    const id = (this.stmtUserByNum.get(number) as { id: string } | undefined)?.id ?? null;
    if (id !== null) {
      this.numToUserId.set(number, id);
      this.userIdToNum.set(id, number);
    }
    return id;
  }

  /** A group's or channel's number, which is negative, as Telegram's are. */
  chatNumber(groupId: string): number {
    const cached = this.groupIdToNum.get(groupId);
    if (cached !== undefined) return cached;
    let row = this.stmtChatById.get(groupId) as { n: number } | undefined;
    if (!row) {
      this.stmtChatInsert.run(groupId);
      row = this.stmtChatById.get(groupId) as { n: number };
    }
    const num = -Number(row.n);
    this.groupIdToNum.set(groupId, num);
    this.numToGroupId.set(num, groupId);
    return num;
  }

  chatGroup(number: number): string | null {
    const cached = this.numToGroupId.get(number);
    if (cached !== undefined) return cached;
    const id = (this.stmtChatByNum.get(-number) as { id: string } | undefined)?.id ?? null;
    if (id !== null) {
      this.numToGroupId.set(number, id);
      this.groupIdToNum.set(id, number);
    }
    return id;
  }

  /** The groups and channels the bot's code was told it's in. */
  joinedChats(): string[] {
    return (this.stmtJoinedChats.all() as { id: string }[]).map((row) => row.id);
  }

  setJoined(groupId: string, joined: boolean): void {
    const row = this.stmtChatSetJoined.get(groupId, joined ? 1 : 0) as { n: number } | undefined;
    if (row) {
      const num = -Number(row.n);
      this.groupIdToNum.set(groupId, num);
      this.numToGroupId.set(num, groupId);
    }
  }

  // --- Messages ---

  /** The number a message goes by, given the first time it's asked for. */
  messageNumber(groupId: string, id: string): number {
    let row = this.stmtMsgByKey.get(groupId, id) as { n: number } | undefined;
    if (!row) {
      this.stmtMsgInsert.run(groupId, id);
      row = this.stmtMsgByKey.get(groupId, id) as { n: number };
    }
    return Number(row.n);
  }

  message(number: number): StoredMessage | null {
    const row = this.stmtMsgByNum.get(number) as { n: number; group_id: string; id: string; edited_at: number | null } | undefined;
    return row ? { number: Number(row.n), groupId: row.group_id, id: row.id, editedAt: row.edited_at === null ? null : Number(row.edited_at) } : null;
  }

  /** Whether the bot's code was told of a message, and the edit it was last told of. */
  told(groupId: string, id: string): { told: boolean; editedAt: number | null } {
    const row = this.stmtMsgTold.get(groupId, id) as { told: number; edited_at: number | null } | undefined;
    return { told: !!row && Number(row.told) !== 0, editedAt: row?.edited_at == null ? null : Number(row.edited_at) };
  }

  setTold(groupId: string, id: string, editedAt: number | null): void {
    this.stmtMsgSetTold.run(groupId, id, editedAt);
  }

  // --- Updates ---

  /** Keeps an update until it's taken, and gives it the next number. */
  pushUpdate(body: Record<string, unknown>): number {
    return Number(this.stmtUpdatePush.run(JSON.stringify(body)).lastInsertRowid);
  }

  /** The updates from a number on, oldest first. */
  updates(from: number, limit: number): Record<string, unknown>[] {
    const rows = this.stmtUpdatesFrom.all(from, limit) as { n: number; body: string }[];
    return rows.map((row) => ({ update_id: Number(row.n), ...(JSON.parse(row.body) as Record<string, unknown>) }));
  }

  /** The last updates there are, oldest first, for a negative offset. */
  lastUpdates(count: number): Record<string, unknown>[] {
    const rows = this.stmtUpdatesLast.all(count) as { n: number; body: string }[];
    return rows.reverse().map((row) => ({ update_id: Number(row.n), ...(JSON.parse(row.body) as Record<string, unknown>) }));
  }

  /** Lets go of the updates below a number, which the bot's code has taken. */
  confirm(below: number): void {
    this.stmtUpdatesConfirm.run(below);
  }

  dropUpdates(): void {
    this.db.exec("DELETE FROM updates");
  }

  pendingUpdates(): number {
    return Number((this.stmtUpdatesCount.get() as { n: number }).n);
  }

  // --- Files ---

  rememberFile(file: StoredFile): void {
    this.stmtFileSet.run(file.fileId, JSON.stringify(file));
  }

  file(id: string): StoredFile | null {
    const row = this.stmtFileGet.get(id) as { ref: string } | undefined;
    return row ? (JSON.parse(row.ref) as StoredFile) : null;
  }
}
