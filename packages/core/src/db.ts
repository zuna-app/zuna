// Local storage. Implementations exist for SQLite in the app (WASM on OPFS) and
// for Node's SQLite in tests. All calls are synchronous, so a database write can
// never interleave with an MLS state change happening alongside it.

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface LocalDb {
  run(sql: string, params?: SqlValue[]): void;
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T[];
  get<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T | undefined;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface DbProvider {
  open(name: string): Promise<LocalDb>;
  remove(name: string): Promise<void>;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (k TEXT PRIMARY KEY, v BLOB NOT NULL);
  CREATE TABLE mls_kv (k BLOB PRIMARY KEY, v BLOB NOT NULL);
  CREATE TABLE epoch_keys (
    group_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    key BLOB NOT NULL,
    uploaded INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, epoch)
  );
  CREATE TABLE users (id TEXT PRIMARY KEY, data BLOB NOT NULL);
  CREATE TABLE pinned_identities (user_id TEXT PRIMARY KEY, identity_key BLOB NOT NULL);
  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    peer_id TEXT,
    data BLOB NOT NULL,
    synced_seq INTEGER NOT NULL DEFAULT 0,
    last_activity_at INTEGER NOT NULL DEFAULT 0,
    known_members TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX groups_peer ON groups(peer_id);
  CREATE TABLE messages (
    row_id INTEGER PRIMARY KEY,
    group_id TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER,
    updated_seq INTEGER NOT NULL DEFAULT 0,
    sender_user TEXT NOT NULL,
    sender_device TEXT NOT NULL DEFAULT '',
    epoch INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    pinned_at INTEGER,
    pinned_by TEXT,
    status TEXT NOT NULL,
    body BLOB,
    raw BLOB,
    UNIQUE (group_id, id)
  );
  CREATE INDEX messages_order ON messages(group_id, seq);
  CREATE INDEX messages_status ON messages(status);
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    group_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE verified (user_id TEXT PRIMARY KEY, identity_key BLOB NOT NULL);
  CREATE VIRTUAL TABLE search USING fts5(tokens, content='', contentless_delete=1);
  `,
  // Notices only one device knows about had no place in the order, so they sank below every sent message.
  `
  UPDATE messages SET seq = COALESCE(
    (SELECT MAX(m.seq) FROM messages AS m WHERE m.group_id = messages.group_id AND m.created_at <= messages.created_at),
    0
  ) WHERE seq IS NULL AND id LIKE 'sys-%';
  `,
];

export function migrate(db: LocalDb): void {
  const row = db.get<{ user_version: number }>("PRAGMA user_version");
  const version = row?.user_version ?? 0;
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.run(MIGRATIONS[i]!);
      db.run(`PRAGMA user_version = ${i + 1}`);
    });
  }
}
