package store

// migrations are SQLite's, in step with postgresMigrations: each change to the
// schema goes at the end of both.
var migrations = []string{`
CREATE TABLE settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL,
	username_key TEXT NOT NULL UNIQUE,
	role TEXT NOT NULL DEFAULT 'member',
	kdf_salt BLOB NOT NULL,
	kdf_memory INTEGER NOT NULL,
	kdf_iterations INTEGER NOT NULL,
	kdf_parallelism INTEGER NOT NULL,
	auth_hash BLOB NOT NULL,
	auth_salt BLOB NOT NULL,
	recovery_hash BLOB NOT NULL,
	recovery_salt BLOB NOT NULL,
	wrapped_key_password BLOB NOT NULL,
	wrapped_key_recovery BLOB NOT NULL,
	identity_key BLOB NOT NULL,
	hpke_key BLOB NOT NULL,
	hpke_key_sig BLOB NOT NULL,
	vault_core BLOB NOT NULL,
	profile BLOB,
	avatar_file TEXT,
	hide_last_seen INTEGER NOT NULL DEFAULT 0,
	last_seen_at INTEGER,
	banned_at INTEGER,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE INDEX users_updated ON users(updated_at);

CREATE TABLE devices (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	certificate BLOB NOT NULL,
	signature_key BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL,
	revoked_at INTEGER
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE sessions (
	token_hash BLOB PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE invites (
	code TEXT PRIMARY KEY,
	created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
	grants_role TEXT NOT NULL DEFAULT 'member',
	max_uses INTEGER NOT NULL DEFAULT 0,
	uses INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER,
	revoked_at INTEGER,
	created_at INTEGER NOT NULL
);

CREATE TABLE key_packages (
	id INTEGER PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	last_resort INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX key_packages_device ON key_packages(device_id, last_resort);

CREATE TABLE groups (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL,
	dm_key TEXT UNIQUE,
	epoch INTEGER NOT NULL DEFAULT 0,
	seq INTEGER NOT NULL DEFAULT 0,
	group_info BLOB,
	meta BLOB,
	meta_epoch INTEGER,
	history_visible INTEGER NOT NULL DEFAULT 0,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role TEXT NOT NULL DEFAULT 'member',
	joined_at INTEGER NOT NULL,
	visible_from_seq INTEGER NOT NULL DEFAULT 0,
	read_state BLOB,
	PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);

CREATE TABLE group_events (
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	kind TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	data BLOB,
	sender_user TEXT NOT NULL,
	sender_device TEXT,
	target_user TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (group_id, seq)
);

CREATE TABLE messages (
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	updated_seq INTEGER NOT NULL,
	sender_user TEXT NOT NULL,
	sender_device TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	envelope BLOB,
	file_ids TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	edited_at INTEGER,
	deleted_at INTEGER,
	pinned_at INTEGER,
	pinned_by TEXT,
	PRIMARY KEY (group_id, id)
);
CREATE INDEX messages_seq ON messages(group_id, seq);
CREATE INDEX messages_updated ON messages(group_id, updated_seq);
CREATE INDEX messages_pinned ON messages(group_id, pinned_at) WHERE pinned_at IS NOT NULL;
CREATE INDEX messages_created ON messages(created_at);

CREATE TABLE reactions (
	group_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (group_id, message_id, id),
	FOREIGN KEY (group_id, message_id) REFERENCES messages(group_id, id) ON DELETE CASCADE
);

CREATE TABLE welcomes (
	id INTEGER PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX welcomes_device ON welcomes(device_id);

CREATE TABLE vault_items (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	data BLOB NOT NULL,
	PRIMARY KEY (user_id, id)
);
CREATE INDEX vault_items_seq ON vault_items(user_id, seq);

CREATE TABLE history_grants (
	id INTEGER PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX history_grants_user ON history_grants(user_id);

CREATE TABLE files (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	chunk_count INTEGER NOT NULL,
	total_size INTEGER NOT NULL,
	completed_at INTEGER,
	attached_at INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX files_cleanup ON files(attached_at, created_at);

CREATE TABLE emotes (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	animated INTEGER NOT NULL DEFAULT 0,
	zero_width INTEGER NOT NULL DEFAULT 0,
	width INTEGER NOT NULL DEFAULT 0,
	height INTEGER NOT NULL DEFAULT 0,
	in_set INTEGER NOT NULL DEFAULT 0
);
`, `
ALTER TABLE emotes ADD COLUMN owner TEXT NOT NULL DEFAULT '';
`, `
-- A client deletes these by ID from a list it may have fetched a while ago. If
-- an ID came back for a newer row, that delete would remove the wrong one.
CREATE TABLE welcomes_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
INSERT INTO welcomes_new SELECT id, device_id, group_id, data, created_at FROM welcomes;
DROP TABLE welcomes;
ALTER TABLE welcomes_new RENAME TO welcomes;
CREATE INDEX welcomes_device ON welcomes(device_id);

CREATE TABLE history_grants_new (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
	data BLOB NOT NULL,
	created_at INTEGER NOT NULL
);
INSERT INTO history_grants_new SELECT id, user_id, group_id, data, created_at FROM history_grants;
DROP TABLE history_grants;
ALTER TABLE history_grants_new RENAME TO history_grants;
CREATE INDEX history_grants_user ON history_grants(user_id);
`, `
-- Where to wake a phone for new messages: the relay that reaches it, the
-- relay's handle for it, and the key its pushes are sealed with. Muted holds
-- the groups not to push for, comma-separated, while the app can't filter
-- notifications itself.
CREATE TABLE push_registrations (
	device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	relay TEXT NOT NULL,
	handle TEXT NOT NULL,
	push_key BLOB NOT NULL,
	registration TEXT NOT NULL,
	muted TEXT NOT NULL DEFAULT '',
	updated_at INTEGER NOT NULL
);
CREATE INDEX push_registrations_user ON push_registrations(user_id);
`, `
-- Which messages use which files. A file is only deleted once nothing refers to
-- it, and only members of a conversation holding it may read it.
CREATE TABLE file_refs (
	file_id TEXT NOT NULL,
	group_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	PRIMARY KEY (file_id, group_id, message_id),
	FOREIGN KEY (group_id, message_id) REFERENCES messages(group_id, id) ON DELETE CASCADE
);
CREATE INDEX file_refs_message ON file_refs(group_id, message_id);
WITH RECURSIVE split(group_id, message_id, file_id, rest) AS (
	SELECT group_id, id, substr(file_ids, 1, 32), substr(file_ids, 34) FROM messages WHERE file_ids != ''
	UNION ALL
	SELECT group_id, message_id, substr(rest, 1, 32), substr(rest, 34) FROM split WHERE rest != ''
)
INSERT OR IGNORE INTO file_refs(file_id, group_id, message_id) SELECT file_id, group_id, message_id FROM split;
ALTER TABLE messages DROP COLUMN file_ids;

-- Standalone files, such as group pictures, belong to no message. The server
-- can't tell which group's picture one is, so any account may read it.
ALTER TABLE files ADD COLUMN standalone INTEGER NOT NULL DEFAULT 0;
-- How much of an upload has arrived, and when the last part did.
ALTER TABLE files ADD COLUMN received INTEGER NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN touched_at INTEGER;
UPDATE files SET standalone = 1 WHERE attached_at IS NOT NULL
	AND id NOT IN (SELECT file_id FROM file_refs)
	AND id NOT IN (SELECT avatar_file FROM users WHERE avatar_file IS NOT NULL);
CREATE INDEX files_owner ON files(owner_id);
CREATE INDEX users_avatar ON users(avatar_file);
CREATE INDEX sessions_last_used ON sessions(last_used_at);
`, `
-- Generations of an account's keys (docs/ACCOUNT_KEY_ROTATION.md). identity_key
-- stays the key the account began with, which clients from before this still pin.
ALTER TABLE users ADD COLUMN key_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN identity_head BLOB;
ALTER TABLE users ADD COLUMN profile_sig BLOB;
ALTER TABLE users ADD COLUMN bridge BLOB;
ALTER TABLE devices ADD COLUMN seal_key BLOB;
ALTER TABLE devices ADD COLUMN seal_sig BLOB;
ALTER TABLE devices ADD COLUMN enroll_proof BLOB;
ALTER TABLE vault_items ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
CREATE INDEX vault_items_generation ON vault_items(user_id, generation);

CREATE TABLE identity_links (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	generation INTEGER NOT NULL,
	payload BLOB NOT NULL,
	by_prev BLOB NOT NULL,
	by_new BLOB NOT NULL,
	by_device BLOB NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (user_id, generation)
);

-- The password's and recovery key's public-key wrappers of the account key.
CREATE TABLE account_slots (
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	seal_key BLOB NOT NULL,
	sign_key BLOB NOT NULL,
	sealed_secret BLOB NOT NULL,
	sealed_key BLOB NOT NULL,
	PRIMARY KEY (user_id, kind)
);

-- The account key sealed for each device: only the newest is ever needed.
CREATE TABLE account_bundles (
	device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	generation INTEGER NOT NULL,
	data BLOB NOT NULL
);

-- Removals from before this are nobody's cue to rotate.
INSERT OR IGNORE INTO settings(key, value) VALUES('account_protocol_since', CAST(CAST(strftime('%s', 'now') AS INTEGER) * 1000 AS TEXT));
`, `
-- Whether a sign-in key is known to be the kind bound to this server. Only one
-- that isn't may still be moved by a proof of the older key, which anyone with a
-- copy of this database could also make.
ALTER TABLE users ADD COLUMN auth_bound INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN recovery_bound INTEGER NOT NULL DEFAULT 0;
`, `
-- The group info a commit replaced, for a while, so that undoing a commit nobody
-- can apply goes back to something the server already held.
ALTER TABLE group_events ADD COLUMN replaced_info BLOB;
CREATE INDEX group_events_replaced_info ON group_events(group_id, epoch) WHERE replaced_info IS NOT NULL;
`, `
-- What someone has stored besides files, and in commits. Running totals, as working
-- them out takes too long to do for every message. The server recounts them hourly.
ALTER TABLE users ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN commit_bytes INTEGER NOT NULL DEFAULT 0;
`, `
-- Which generation a device's seal key is from, signed by it, so that clients can
-- refuse one older than it's said before. seal_sig stays for those that don't know.
ALTER TABLE devices ADD COLUMN seal_generation INTEGER;
ALTER TABLE devices ADD COLUMN seal_proof BLOB;
`, `
-- Sign-in attempts for each account, however many addresses they came from, so
-- that restarting the server doesn't give whoever is guessing a fresh start.
CREATE TABLE sign_in_attempts (
	account TEXT PRIMARY KEY,
	attempts INTEGER NOT NULL,
	until_at INTEGER NOT NULL,
	seen_at INTEGER NOT NULL
);
`, `
-- Who deleted a message, and what their device signed to say so, which clients
-- check before erasing their own copies. The server can't read or forge it.
ALTER TABLE messages ADD COLUMN deleted_by TEXT;
ALTER TABLE messages ADD COLUMN deletion BLOB;
`, `
-- Whether a device has signed a request with its key, after which the requests
-- that need one must always come signed.
ALTER TABLE devices ADD COLUMN signs_requests INTEGER NOT NULL DEFAULT 0;
`, `
-- What the device that last pinned or unpinned a message signed to say so, and
-- whose it was. Clients only show a pin someone's device signed.
ALTER TABLE messages ADD COLUMN pin BLOB;
ALTER TABLE messages ADD COLUMN pin_by TEXT;
`, `
-- When a disappearing message goes, as its sender's app asked. The server can't
-- read how long a chat's messages last, only when each one is due.
ALTER TABLE messages ADD COLUMN expires_at INTEGER;
CREATE INDEX messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
`, `
-- Channels are groups anyone on the server can join, listed for everyone. Their
-- names are sealed with the community key, which the server doesn't hold. A member's
-- proof says they hold it too, and other members check it, so the server can't put a
-- stranger on a channel's roster. Someone waiting for a channel's older keys is
-- answered by whichever member comes across it first.
CREATE TABLE channels (
	id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
	type TEXT NOT NULL,
	position INTEGER NOT NULL,
	user_limit INTEGER NOT NULL DEFAULT 0,
	details BLOB NOT NULL,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
ALTER TABLE group_members ADD COLUMN proof BLOB;
ALTER TABLE group_members ADD COLUMN history_wanted INTEGER NOT NULL DEFAULT 0;
`, `
-- How many may share a screen at once in a voice channel: 0 leaves it to the server's
-- rules, and -1 is nobody.
ALTER TABLE channels ADD COLUMN screen_limit INTEGER NOT NULL DEFAULT 0;
`, `
-- Whether a phone's app hides what it shouldn't show itself, so it's pushed for
-- everything, channels too.
ALTER TABLE push_registrations ADD COLUMN filters INTEGER NOT NULL DEFAULT 0;
`, `
-- The relay's handle for a phone's VoIP token, which calls ring through, or empty where
-- the phone has none, as where CallKit is left out.
ALTER TABLE push_registrations ADD COLUMN call_handle TEXT NOT NULL DEFAULT '';
`, `
-- The soundboard: sounds a server's admins add, which anyone in a voice channel or a
-- call can play to the others there. What each is called, and the key to its file,
-- are sealed with the community key.
CREATE TABLE sounds (
	id TEXT PRIMARY KEY,
	details BLOB NOT NULL,
	file_id TEXT NOT NULL UNIQUE,
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
-- Whether the soundboard can be played in a voice channel.
ALTER TABLE channels ADD COLUMN sounds INTEGER NOT NULL DEFAULT 1;
`, `
-- Slow mode: how long each person waits between messages in a channel, in seconds, or 0.
ALTER TABLE channels ADD COLUMN slow_mode INTEGER NOT NULL DEFAULT 0;
-- When each person last sent a message in a channel, which leaving it doesn't forget.
CREATE TABLE channel_sends (
	channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	sent_at INTEGER NOT NULL,
	PRIMARY KEY (channel_id, user_id)
);
`, `
-- What only apps from before slots, generations, bound sign-in keys and signed
-- requests needed: the wrappers of an account's first key and the bridge that
-- carried later keys to them, whether a sign-in key or a device had moved on yet,
-- a seal key's signature that didn't say its generation, and when this server
-- began keeping generations.
ALTER TABLE users DROP COLUMN wrapped_key_password;
ALTER TABLE users DROP COLUMN wrapped_key_recovery;
ALTER TABLE users DROP COLUMN bridge;
ALTER TABLE users DROP COLUMN auth_bound;
ALTER TABLE users DROP COLUMN recovery_bound;
ALTER TABLE devices DROP COLUMN seal_sig;
ALTER TABLE devices DROP COLUMN signs_requests;
DELETE FROM settings WHERE key = 'account_protocol_since';
`, `
-- The number an item's own content carries, such as the manifest's, which a write
-- has to raise, so that two devices writing at once can't undo one another.
ALTER TABLE vault_items ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
`, `
-- When someone deleted their account. What stays of it is what others need to go
-- on reading what they sent: its ID, its public keys and its devices' certificates.
ALTER TABLE users ADD COLUMN deleted_at INTEGER;
`, `
-- Someone reported to the server's admins, why and when. Who reported them isn't
-- kept, and nothing of what was said ever reaches the server.
CREATE TABLE reports (
	id INTEGER PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	reason TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX reports_user ON reports(user_id);
`, `
-- A session by its device, which telling who to push to looks up for every message,
-- and which revoking a device or signing out deletes by.
CREATE INDEX sessions_device ON sessions(device_id);
`, `
-- What deleting a group cascades to, which would otherwise read all of each table.
CREATE INDEX welcomes_group ON welcomes(group_id);
CREATE INDEX history_grants_group ON history_grants(group_id);
`, `
-- Which admin banned someone, for the server's list of bans.
ALTER TABLE users ADD COLUMN banned_by TEXT;
`, `
-- The commits old enough to prune, which the hourly prune would otherwise find by
-- reading every commit, and every commit's whole data, with the write lock held.
CREATE INDEX group_events_commits ON group_events(created_at) WHERE kind = 'commit';
`, `
-- A group's GroupInfo, which carries its whole ratchet tree and so grows with every
-- device in it. In the group's row, SQLite wrote it again with each message, which
-- moves the row's seq, and read past it for the columns after it.
CREATE TABLE group_infos (
	group_id TEXT PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
	info BLOB NOT NULL
);
INSERT INTO group_infos(group_id, info) SELECT id, group_info FROM groups WHERE group_info IS NOT NULL;
ALTER TABLE groups DROP COLUMN group_info;
`, `
-- Bots: accounts someone here makes and owns, which a program of theirs runs. One is
-- made waiting, with the username it will take and a one-use invite that grants it,
-- and its ID becomes its account's when that program signs up. A private one is
-- listed only for its owner and for whoever is in a chat with it. setup_proof is the
-- bot's signature on its identity key, by a key only its setup link held, which its
-- owner's app checks.
CREATE TABLE bots (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	username TEXT NOT NULL,
	username_key TEXT NOT NULL,
	listed INTEGER NOT NULL DEFAULT 0,
	add_policy TEXT NOT NULL DEFAULT 'owner',
	files INTEGER NOT NULL DEFAULT 1,
	invite_code TEXT,
	setup_proof BLOB,
	created_at INTEGER NOT NULL,
	set_up_at INTEGER,
	deleted_at INTEGER
);
CREATE INDEX bots_owner ON bots(owner_id);
-- A waiting bot holds its username until it signs up with it.
CREATE UNIQUE INDEX bots_waiting_username ON bots(username_key) WHERE set_up_at IS NULL;
-- The channels a server admin gave a bot, which are the only ones it may join.
CREATE TABLE bot_channels (
	bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
	channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	PRIMARY KEY (bot_id, channel_id)
);
`, `
-- The groups a phone was sent a notification for and hasn't been told to clear,
-- comma-separated. They were only kept in memory, so after a restart a chat read
-- elsewhere left its notification on the phone.
ALTER TABLE push_registrations ADD COLUMN notified TEXT NOT NULL DEFAULT '';
`, `
-- The public half of the key every member of a group's current epoch can make, which
-- sealed requests are signed with, beside the group info whoever made the epoch gave
-- with it. A commit keeps the one it made, and the one it replaced, to go back to.
ALTER TABLE group_infos ADD COLUMN send_key BLOB;
ALTER TABLE group_events ADD COLUMN send_key BLOB;
ALTER TABLE group_events ADD COLUMN replaced_send_key BLOB;
`, `
-- The keys tokens are issued under, one for each size in each period, the tokens each
-- person was issued in a period, and the inputs of those spent, which say nothing of
-- whose they were. All go once their period can't redeem anything any more.
CREATE TABLE token_keys (
	period INTEGER NOT NULL,
	size TEXT NOT NULL,
	secret BLOB NOT NULL,
	public BLOB NOT NULL,
	PRIMARY KEY (period, size)
);
CREATE TABLE token_issues (
	user_id TEXT NOT NULL,
	period INTEGER NOT NULL,
	size TEXT NOT NULL,
	issued INTEGER NOT NULL,
	PRIMARY KEY (user_id, period, size)
);
CREATE INDEX token_issues_period ON token_issues(period);
CREATE TABLE spent_tokens (
	period INTEGER NOT NULL,
	size TEXT NOT NULL,
	input BLOB NOT NULL,
	PRIMARY KEY (period, size, input)
);
`, `
-- A message's and a reaction's item key, the public half of a key only its author's
-- devices can make, which changing or deleting it takes. It names nobody.
ALTER TABLE messages ADD COLUMN item_key BLOB;
ALTER TABLE reactions ADD COLUMN item_key BLOB;
-- The hash of the secret a file was made with, which a message carrying it shows.
-- A file a message carries belongs to nobody from then on.
ALTER TABLE files ADD COLUMN share_hash BLOB;
UPDATE files SET owner_id = '' WHERE attached_at IS NOT NULL AND standalone = 0;
-- How many MiB each person uploaded each day, which their quota counts over thirty days.
CREATE TABLE uploads (
	user_id TEXT NOT NULL,
	day INTEGER NOT NULL,
	mib INTEGER NOT NULL,
	PRIMARY KEY (user_id, day)
);
`, `
-- Nothing kept says who sent, pinned or deleted a message, or whose a reaction is: that's
-- inside them, under their devices' signatures, and the requests that add or change them
-- name nobody. Slow mode is each app's to hold, so nothing records who sent when either.
ALTER TABLE messages DROP COLUMN sender_user;
ALTER TABLE messages DROP COLUMN sender_device;
ALTER TABLE messages DROP COLUMN pinned_by;
ALTER TABLE messages DROP COLUMN pin_by;
ALTER TABLE messages DROP COLUMN deleted_by;
ALTER TABLE reactions DROP COLUMN user_id;
DROP TABLE channel_sends;
`, `
-- When a reaction was taken back. Its row stays, without what it carried, so that
-- its ID can't be used again: what a reaction carries is signed by whoever added it,
-- and any member who saw it could otherwise put it back as theirs.
ALTER TABLE reactions ADD COLUMN removed_at INTEGER;
`, `
-- The log of keys: every change to who holds which keys, hashed into a Merkle tree
-- whose head the server signs, by era and place (log.go). Its key, era and frontier
-- are in settings.
CREATE TABLE log_entries (
	era INTEGER NOT NULL,
	idx INTEGER NOT NULL,
	record BLOB NOT NULL,
	body BLOB NOT NULL,
	user_id TEXT NOT NULL,
	root BLOB NOT NULL,
	PRIMARY KEY (era, idx)
);
CREATE INDEX log_entries_user ON log_entries(user_id, era, idx);
`, `
-- Whether people in a voice channel may watch YouTube together there.
ALTER TABLE channels ADD COLUMN watch INTEGER NOT NULL DEFAULT 1;
`}
