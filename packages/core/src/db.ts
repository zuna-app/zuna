// Local storage, SQLite on every host: as WebAssembly on OPFS in the web app,
// native SQLite in the desktop app and on iOS, and Node's in tests. All calls are
// synchronous, so a database write can never interleave with an MLS state change
// happening alongside it.

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
  // joined_epochs: where this device last came into each group. Keys for later
  // epochs only ever come from MLS itself.
  // epoch_starts: which commit began each epoch, so a message can't claim one long over.
  // device_departures: when each device left each group's tree.
  // Pins are shared between an account's devices through its vault.
  `
  CREATE TABLE joined_epochs (group_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
  CREATE TABLE epoch_starts (group_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (group_id, epoch));
  CREATE TABLE device_departures (group_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (group_id, device_id));
  ALTER TABLE pinned_identities ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0;
  INSERT OR IGNORE INTO joined_epochs(group_id, epoch) SELECT group_id, MIN(epoch) FROM epoch_keys GROUP BY group_id;
  `,
  // identity_chain: the links of each person's chain of identity keys, this account's included.
  // identity_state: how far this account has got along each chain, and whether it has seen two.
  // device_first_leaf: when each device was first seen holding a leaf in a tree shared with this
  // device, on this device's clock, since the server's word on how old a device is proves nothing.
  `
  CREATE TABLE identity_chain (
    user_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    payload BLOB NOT NULL,
    by_prev BLOB NOT NULL,
    by_new BLOB NOT NULL,
    by_device BLOB NOT NULL,
    PRIMARY KEY (user_id, generation)
  );
  CREATE TABLE identity_state (
    user_id TEXT PRIMARY KEY,
    forked INTEGER NOT NULL DEFAULT 0,
    known_generation INTEGER NOT NULL DEFAULT 0,
    known_hash BLOB,
    chain_uploaded INTEGER NOT NULL DEFAULT 1,
    trust_generation INTEGER NOT NULL DEFAULT 0,
    trust_uploaded INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE device_first_leaf (user_id TEXT NOT NULL, device_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, device_id));
  `,
  // When the server said a message was deleted, by this device's clock, without a
  // deletion its author or an admin signed. Its copy is hidden and kept until then.
  `ALTER TABLE messages ADD COLUMN unproven_delete_at INTEGER;`,
  // How many photos, files, links and so on each message holds, for the lists in a
  // chat's details. The kind is a keyed hash, as words are in the search index.
  `
  CREATE TABLE media (
    row_id INTEGER NOT NULL,
    group_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (row_id, kind)
  );
  CREATE INDEX media_group ON media(group_id, kind);
  `,
  // Which pin or unpin a member's device signed decides whether a message is pinned
  // here, and this is its revision. Null for a pin this device held from before pins were signed.
  `ALTER TABLE messages ADD COLUMN pin_revision INTEGER;`,
  // When a disappearing message goes from this device, worked out from when it was
  // sent and how long its sender's app said it lasts. `expired` holds the ones that
  // went, so a copy the server sends again, or a reply to one, knows it's gone.
  `
  ALTER TABLE messages ADD COLUMN expires_at INTEGER;
  CREATE INDEX messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;
  CREATE TABLE expired (group_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (group_id, id));
  `,
  // A mention of this account, or a reply to it, that was jumped to before the chat
  // was read that far, so it no longer counts as waiting.
  `ALTER TABLE messages ADD COLUMN mention_seen INTEGER NOT NULL DEFAULT 0;`,
  // Someone's own last message in a channel, which its slow mode counts from.
  `CREATE INDEX messages_sender ON messages(group_id, sender_user, created_at);`,
  // A device ID is only someone's together with whose it is, so departures name both.
  // What was recorded before isn't moved.
  `
  DROP TABLE device_departures;
  CREATE TABLE device_departures (group_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (group_id, user_id, device_id));
  `,
  // The epoch from which each device has been in each group's tree, as this device saw it,
  // so a message under an epoch it was there for can only be from someone who was too.
  `CREATE TABLE device_arrivals (group_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY (group_id, user_id, device_id));`,
  // Everything sealed at rest names its table and row, and what decides whom to trust
  // or what to believe is sealed too, so nothing outside the app can change or move it.
  // Nothing is moved: the device fetches it all again, as a new one would.
  `
  DELETE FROM kv; DELETE FROM mls_kv; DELETE FROM epoch_keys; DELETE FROM users; DELETE FROM groups;
  DELETE FROM search; DELETE FROM media; DELETE FROM messages; DELETE FROM outbox; DELETE FROM expired;
  DELETE FROM pinned_identities; DELETE FROM verified; DELETE FROM identity_chain;
  DROP TABLE joined_epochs; CREATE TABLE joined_epochs (group_id TEXT PRIMARY KEY, epoch BLOB NOT NULL);
  DROP TABLE epoch_starts; CREATE TABLE epoch_starts (group_id TEXT NOT NULL, epoch INTEGER NOT NULL, seq BLOB NOT NULL, PRIMARY KEY (group_id, epoch));
  DROP TABLE device_departures; CREATE TABLE device_departures (group_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch BLOB NOT NULL, PRIMARY KEY (group_id, user_id, device_id));
  DROP TABLE device_arrivals; CREATE TABLE device_arrivals (group_id TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch BLOB NOT NULL, PRIMARY KEY (group_id, user_id, device_id));
  DROP TABLE device_first_leaf; CREATE TABLE device_first_leaf (user_id TEXT NOT NULL, device_id TEXT NOT NULL, at BLOB NOT NULL, PRIMARY KEY (user_id, device_id));
  DROP TABLE identity_state; CREATE TABLE identity_state (user_id TEXT PRIMARY KEY, sealed BLOB, chain_uploaded INTEGER NOT NULL DEFAULT 1, trust_uploaded INTEGER NOT NULL DEFAULT 1);
  `,
  // The reactions to a message that hasn't opened yet, kept until it does.
  `ALTER TABLE messages ADD COLUMN raw_reactions BLOB;`,
  // Pins went up one by one once; the manifest carries them all now, and nothing read this.
  `ALTER TABLE pinned_identities DROP COLUMN uploaded;`,
  // When each disappearing message went, so its ID can be let go long after. Those already here count from now.
  `
  ALTER TABLE expired ADD COLUMN at INTEGER NOT NULL DEFAULT 0;
  UPDATE expired SET at = CAST(strftime('%s', 'now') AS INTEGER) * 1000;
  `,
  // The few messages whose deletion is still to be proven, which each start would
  // otherwise find by reading every message there is.
  `CREATE INDEX messages_unproven ON messages(unproven_delete_at) WHERE unproven_delete_at IS NOT NULL;`,
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
