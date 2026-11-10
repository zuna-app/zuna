package store

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"sort"
)

// Message is an encrypted message and its server-visible state. Nothing here says
// who sent it, pinned it or deleted it: that's inside what it carries, under their
// devices' signatures, and the requests that add or change it name nobody.
//
// Sync is state-based: every change to a message moves it to a new updated_seq,
// so a client that was offline fetches the current state of whatever changed
// instead of replaying each edit.
type Message struct {
	GroupID    string `json:"group_id"`
	ID         string `json:"id"`
	Seq        int64  `json:"seq"`
	UpdatedSeq int64  `json:"updated_seq"`
	Epoch      int64  `json:"epoch"`
	Envelope   []byte `json:"envelope,omitempty"`
	// ItemKey is the public half of the key only its author's devices can make,
	// which changing or deleting it takes. It names nobody.
	ItemKey   []byte `json:"item_key,omitempty"`
	CreatedAt int64  `json:"created_at"`
	EditedAt  *int64 `json:"edited_at"`
	DeletedAt *int64 `json:"deleted_at"`
	PinnedAt  *int64 `json:"pinned_at"`
	// What the deleting device signed, which apps check before erasing their copies.
	Deletion []byte `json:"deletion,omitempty"`
	// What the device that last pinned or unpinned it signed.
	Pin []byte `json:"pin,omitempty"`
	// When it disappears, as its sender's app asked, if it does.
	ExpiresAt *int64     `json:"expires_at,omitempty"`
	Reactions []Reaction `json:"reactions"`
}

// Reaction is an encrypted reaction; the server can't tell which emote it is, or whose.
type Reaction struct {
	ID        string `json:"id"`
	Epoch     int64  `json:"epoch"`
	Data      []byte `json:"data"`
	ItemKey   []byte `json:"item_key,omitempty"`
	CreatedAt int64  `json:"created_at"`
}

// FileShare is a file a message carries, with the secret its uploader made it with,
// which shows whoever sends the message holds it.
type FileShare struct {
	ID     string `json:"id"`
	Secret []byte `json:"secret"`
}

// ShareSecretLen is how long a file's share secret is.
const ShareSecretLen = 32

const messageColumns = `group_id, id, seq, updated_seq, epoch, envelope, item_key,
	created_at, edited_at, deleted_at, pinned_at, deletion, pin, expires_at`

func scanMessage(row interface{ Scan(...any) error }) (*Message, error) {
	var m Message
	var edited, deleted, pinned, expires sql.NullInt64
	if err := row.Scan(&m.GroupID, &m.ID, &m.Seq, &m.UpdatedSeq, &m.Epoch, &m.Envelope, &m.ItemKey,
		&m.CreatedAt, &edited, &deleted, &pinned, &m.Deletion, &m.Pin, &expires); err != nil {
		return nil, err
	}
	m.ExpiresAt = nullableInt(expires)
	m.EditedAt = nullableInt(edited)
	m.DeletedAt = nullableInt(deleted)
	m.PinnedAt = nullableInt(pinned)
	m.Reactions = []Reaction{}
	return &m, nil
}

func (d *DB) attachReactions(ctx context.Context, groupID string, messages []*Message) error {
	if len(messages) == 0 {
		return nil
	}
	byID := make(map[string]*Message, len(messages))
	args := make([]any, 0, len(messages)+1)
	args = append(args, groupID)
	for _, m := range messages {
		byID[m.ID] = m
		args = append(args, m.ID)
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT message_id, id, epoch, data, item_key, created_at FROM reactions
		WHERE group_id = ? AND message_id IN (`+placeholders(len(messages))+`) ORDER BY created_at`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var r Reaction
		if err := rows.Scan(&messageID, &r.ID, &r.Epoch, &r.Data, &r.ItemKey, &r.CreatedAt); err != nil {
			return err
		}
		byID[messageID].Reactions = append(byID[messageID].Reactions, r)
	}
	return rows.Err()
}

func currentEpoch(ctx context.Context, tx handle, groupID string) (int64, error) {
	var epoch int64
	err := tx.QueryRowContext(ctx, `SELECT epoch FROM groups WHERE id = ?`, groupID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return epoch, err
}

// atEpoch refuses what's sealed for an epoch that isn't a group's current one, so a
// removed member's key is never reused.
func atEpoch(ctx context.Context, tx handle, groupID string, epoch int64) error {
	current, err := currentEpoch(ctx, tx, groupID)
	if err != nil {
		return err
	}
	if current != epoch {
		return &EpochConflictError{Current: current}
	}
	return nil
}

// CreateMessage stores a message, sealed by one of a group's members of its current
// epoch, which spends a token. Sending the same ID twice with the same item key
// returns the message that arrived, with created false and nothing spent, which
// makes retries safe; with another item key it's a conflict. Each file it carries
// takes its share secret, and from then on the file belongs to nobody. A message
// with expiresIn (ms) above zero disappears that long after it arrives.
func (d *DB) CreateMessage(ctx context.Context, m Message, files []FileShare, token *Token, expiresIn int64) (message *Message, created bool, err error) {
	err = d.tx(ctx, func(tx handle) error {
		created = false
		var existing []byte
		err := tx.QueryRowContext(ctx, `SELECT item_key FROM messages WHERE group_id = ? AND id = ?`, m.GroupID, m.ID).Scan(&existing)
		if err == nil {
			// A retry of a message that already arrived.
			if subtle.ConstantTimeCompare(existing, m.ItemKey) != 1 {
				return ErrConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if err := atEpoch(ctx, tx, m.GroupID, m.Epoch); err != nil {
			return err
		}
		if err := spendToken(ctx, tx, token, TokenSizeFor(len(m.Envelope))); err != nil {
			return err
		}
		now := Now()
		seq, err := nextSeq(ctx, tx, m.GroupID)
		if err != nil {
			return err
		}
		var expiresAt *int64
		if expiresIn > 0 {
			at := now + expiresIn
			expiresAt = &at
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO messages(group_id, id, seq, updated_seq, epoch, envelope, item_key, created_at, expires_at)
			VALUES(?,?,?,?,?,?,?,?,?)`, m.GroupID, m.ID, seq, seq, m.Epoch, m.Envelope, m.ItemKey, now, expiresAt); err != nil {
			return err
		}
		for _, file := range files {
			if err := shareFile(ctx, tx, file, m.GroupID, m.ID, now); err != nil {
				return err
			}
		}
		created = true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	message, err = d.Message(ctx, m.GroupID, m.ID)
	return message, created, err
}

// shareFile ties a file to a message that carries it, if the message's sender showed
// the secret its uploader made it with, and takes its owner away: from then on what's
// kept says nothing of who uploaded it. A forwarded file is shared with the same secret.
func shareFile(ctx context.Context, tx handle, file FileShare, groupID, messageID string, now int64) error {
	var hash []byte
	err := tx.QueryRowContext(ctx, `SELECT share_hash FROM files WHERE id = ? AND completed_at IS NOT NULL`, file.ID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	sum := sha256.Sum256(file.Secret)
	if len(hash) != sha256.Size || subtle.ConstantTimeCompare(hash, sum[:]) != 1 {
		return ErrForbidden
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO file_refs(file_id, group_id, message_id) VALUES(?,?,?) ON CONFLICT DO NOTHING`, file.ID, groupID, messageID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE files SET attached_at = COALESCE(attached_at, ?), owner_id = '' WHERE id = ?`, now, file.ID)
	return err
}

func (d *DB) Message(ctx context.Context, groupID, id string) (*Message, error) {
	m, err := scanMessage(d.sql.QueryRowContext(ctx, `SELECT `+messageColumns+` FROM messages WHERE group_id = ? AND id = ?`, groupID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := d.attachReactions(ctx, groupID, []*Message{m}); err != nil {
		return nil, err
	}
	return m, nil
}

// EditMessage replaces a message's ciphertext, which spends a token. Who may is for
// the caller to have checked, by the message's item key.
func (d *DB) EditMessage(ctx context.Context, groupID, id string, epoch int64, envelope []byte, token *Token) (*Message, error) {
	err := d.tx(ctx, func(tx handle) error {
		var deleted sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT deleted_at FROM messages WHERE group_id = ? AND id = ?`, groupID, id).Scan(&deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if deleted.Valid {
			return ErrForbidden
		}
		if err := atEpoch(ctx, tx, groupID, epoch); err != nil {
			return err
		}
		if err := spendToken(ctx, tx, token, TokenSizeFor(len(envelope))); err != nil {
			return err
		}
		seq, err := nextSeq(ctx, tx, groupID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE messages SET envelope = ?, epoch = ?, edited_at = ?, updated_seq = ?
			WHERE group_id = ? AND id = ?`, envelope, epoch, Now(), seq, groupID, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return d.Message(ctx, groupID, id)
}

// Deletion is the proof a device made to delete a message, under the group's epoch at
// the time, which apps check before erasing their copies. Who made it is inside.
type Deletion struct {
	Epoch int64
	Proof []byte
}

// DeleteMessage erases the ciphertext and leaves a tombstone so every client
// removes it too. It returns the message and the files that are now orphaned. An
// author's deletion is sealed and spends a token; a group admin's is named and doesn't.
func (d *DB) DeleteMessage(ctx context.Context, groupID, id string, deletion Deletion, token *Token) (*Message, []string, error) {
	var fileIDs []string
	err := d.tx(ctx, func(tx handle) error {
		fileIDs = nil
		var deleted sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT deleted_at FROM messages WHERE group_id = ? AND id = ?`, groupID, id).Scan(&deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if deleted.Valid {
			return nil
		}
		// A proof is only made under the current epoch, as content is.
		if deletion.Proof != nil {
			if err := atEpoch(ctx, tx, groupID, deletion.Epoch); err != nil {
				return err
			}
		}
		if token != nil {
			if err := spendToken(ctx, tx, token, SmallToken); err != nil {
				return err
			}
		}
		fileIDs, err = collectStrings(ctx, tx, `SELECT file_id FROM file_refs WHERE group_id = ? AND message_id = ?`, groupID, id)
		if err != nil {
			return err
		}
		seq, err := nextSeq(ctx, tx, groupID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE group_id = ? AND message_id = ?`, groupID, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM file_refs WHERE group_id = ? AND message_id = ?`, groupID, id); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE messages SET envelope = NULL, deleted_at = ?, pinned_at = NULL, pin = NULL, updated_seq = ?,
			deletion = ? WHERE group_id = ? AND id = ?`, Now(), seq, deletion.Proof, groupID, id); err != nil {
			return err
		}
		fileIDs, err = unreferenced(ctx, tx, fileIDs)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	m, err := d.Message(ctx, groupID, id)
	return m, fileIDs, err
}

// touch moves a message to a new updated_seq after a change to its state.
func touch(ctx context.Context, tx handle, groupID, id string) error {
	seq, err := nextSeq(ctx, tx, groupID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE messages SET updated_seq = ? WHERE group_id = ? AND id = ?`, seq, groupID, id)
	return err
}

func messageExists(ctx context.Context, tx handle, groupID, id string) error {
	var deleted sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT deleted_at FROM messages WHERE group_id = ? AND id = ?`, groupID, id).Scan(&deleted)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && deleted.Valid) {
		return ErrNotFound
	}
	return err
}

// ItemKey is the item key of a message, or with reactionID of a reaction to it.
func (d *DB) ItemKey(ctx context.Context, groupID, messageID, reactionID string) ([]byte, error) {
	var key []byte
	var err error
	if reactionID == "" {
		err = d.sql.QueryRowContext(ctx, `SELECT item_key FROM messages WHERE group_id = ? AND id = ?`, groupID, messageID).Scan(&key)
	} else {
		err = d.sql.QueryRowContext(ctx, `SELECT item_key FROM reactions WHERE group_id = ? AND message_id = ? AND id = ?`, groupID, messageID, reactionID).Scan(&key)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return key, err
}

// AddReaction stores a reaction, which spends a token. Like a message, it has to be
// under the current epoch, and adding the same ID twice with the same item key is a
// retry that changes nothing. How many one person puts on a message is for apps to hold.
func (d *DB) AddReaction(ctx context.Context, groupID, messageID string, r Reaction, token *Token) (*Message, error) {
	err := d.tx(ctx, func(tx handle) error {
		if err := messageExists(ctx, tx, groupID, messageID); err != nil {
			return err
		}
		var existing []byte
		err := tx.QueryRowContext(ctx, `SELECT item_key FROM reactions WHERE group_id = ? AND message_id = ? AND id = ?`, groupID, messageID, r.ID).Scan(&existing)
		if err == nil {
			if subtle.ConstantTimeCompare(existing, r.ItemKey) != 1 {
				return ErrConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var all int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM reactions WHERE group_id = ? AND message_id = ?`, groupID, messageID).Scan(&all); err != nil {
			return err
		}
		if all >= maxReactionsOnMessage {
			return ErrLimit
		}
		if err := atEpoch(ctx, tx, groupID, r.Epoch); err != nil {
			return err
		}
		if err := spendToken(ctx, tx, token, SmallToken); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO reactions(group_id, message_id, id, epoch, data, item_key, created_at)
			VALUES(?,?,?,?,?,?,?)`, groupID, messageID, r.ID, r.Epoch, r.Data, r.ItemKey, Now()); err != nil {
			return err
		}
		return touch(ctx, tx, groupID, messageID)
	})
	if err != nil {
		return nil, err
	}
	return d.Message(ctx, groupID, messageID)
}

// RemoveReaction takes a reaction back, which spends a token. Who may is for the
// caller to have checked, by the reaction's item key.
func (d *DB) RemoveReaction(ctx context.Context, groupID, messageID, reactionID string, token *Token) (*Message, error) {
	err := d.tx(ctx, func(tx handle) error {
		if err := spendToken(ctx, tx, token, SmallToken); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE group_id = ? AND message_id = ? AND id = ?`, groupID, messageID, reactionID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil
		}
		return touch(ctx, tx, groupID, messageID)
	})
	if err != nil {
		return nil, err
	}
	return d.Message(ctx, groupID, messageID)
}

// Pin is what a device signed to pin or unpin a message, under the epoch it names.
type Pin struct {
	Epoch int64
	Proof []byte
}

// SetPinned pins or unpins a message for one of its group's members, which spends a token.
func (d *DB) SetPinned(ctx context.Context, groupID, messageID string, pinned bool, pin Pin, token *Token) (*Message, error) {
	err := d.tx(ctx, func(tx handle) error {
		if err := messageExists(ctx, tx, groupID, messageID); err != nil {
			return err
		}
		// A proof is only made under the current epoch, as content is.
		if err := atEpoch(ctx, tx, groupID, pin.Epoch); err != nil {
			return err
		}
		if err := spendToken(ctx, tx, token, SmallToken); err != nil {
			return err
		}
		var err error
		if pinned {
			_, err = tx.ExecContext(ctx, `UPDATE messages SET pinned_at = ?, pin = ? WHERE group_id = ? AND id = ?`, Now(), pin.Proof, groupID, messageID)
		} else {
			_, err = tx.ExecContext(ctx, `UPDATE messages SET pinned_at = NULL, pin = ? WHERE group_id = ? AND id = ?`, pin.Proof, groupID, messageID)
		}
		if err != nil {
			return err
		}
		return touch(ctx, tx, groupID, messageID)
	})
	if err != nil {
		return nil, err
	}
	return d.Message(ctx, groupID, messageID)
}

// SendKey is a group's current epoch and the send key whoever made it gave, which
// sealed requests to it have to be signed with.
func (d *DB) SendKey(ctx context.Context, groupID string) (int64, []byte, error) {
	var epoch int64
	var key []byte
	err := d.sql.QueryRowContext(ctx, `SELECT g.epoch, i.send_key FROM groups g LEFT JOIN group_infos i ON i.group_id = g.id WHERE g.id = ?`, groupID).Scan(&epoch, &key)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil, ErrNotFound
	}
	return epoch, key, err
}

// pinsQuery picks a group's pins seen from a sequence number on. The unary + keeps
// SQLite from taking messages_seq for the range on seq, which reads every message
// in the group, over messages_pinned, which holds only the few that are pinned.
const pinsQuery = `SELECT ` + messageColumns + ` FROM messages
	WHERE group_id = ? AND pinned_at IS NOT NULL AND +seq > ? ORDER BY pinned_at DESC`

// Pins returns pinned messages, newest pin first.
func (d *DB) Pins(ctx context.Context, groupID string, visibleFrom int64) ([]*Message, error) {
	rows, err := d.sql.QueryContext(ctx, pinsQuery, groupID, visibleFrom)
	if err != nil {
		return nil, err
	}
	return d.collectMessages(ctx, groupID, rows)
}

func (d *DB) collectMessages(ctx context.Context, groupID string, rows *sql.Rows) ([]*Message, error) {
	defer rows.Close()
	messages := []*Message{}
	for rows.Next() {
		m, err := scanMessage(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	return messages, d.attachReactions(ctx, groupID, messages)
}

// MessagesBefore returns up to limit messages older than seq, newest first.
func (d *DB) MessagesBefore(ctx context.Context, groupID string, before, visibleFrom int64, limit int) ([]*Message, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages
		WHERE group_id = ? AND seq < ? AND seq > ? ORDER BY seq DESC LIMIT ?`, groupID, before, visibleFrom, limit)
	if err != nil {
		return nil, err
	}
	return d.collectMessages(ctx, groupID, rows)
}

// MessagesAfter returns up to limit messages newer than seq, oldest first, for
// reading on from a reply or search result jumped to.
func (d *DB) MessagesAfter(ctx context.Context, groupID string, after, visibleFrom int64, limit int) ([]*Message, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages
		WHERE group_id = ? AND seq > ? AND seq > ? ORDER BY seq ASC LIMIT ?`, groupID, after, visibleFrom, limit)
	if err != nil {
		return nil, err
	}
	return d.collectMessages(ctx, groupID, rows)
}

// MessagesAround returns the messages surrounding seq, oldest first, for
// jumping to a reply or search result.
func (d *DB) MessagesAround(ctx context.Context, groupID string, seq, visibleFrom int64, limit int) ([]*Message, error) {
	half := limit / 2
	older, err := d.MessagesBefore(ctx, groupID, seq+1, visibleFrom, half+1)
	if err != nil {
		return nil, err
	}
	newer, err := d.MessagesAfter(ctx, groupID, seq, visibleFrom, half)
	if err != nil {
		return nil, err
	}
	all := append(older, newer...)
	sort.Slice(all, func(i, j int) bool { return all[i].Seq < all[j].Seq })
	return all, nil
}

// Changes is one page of a group's change feed.
type Changes struct {
	Messages []*Message   `json:"messages"`
	Events   []GroupEvent `json:"events"`
	// Cursor is what to pass as `after` for the next page.
	Cursor  int64 `json:"cursor"`
	HasMore bool  `json:"has_more"`
}

// ChangesAfter returns everything that changed after seq, in order. Commits
// are always included so a client can follow every epoch transition.
func (d *DB) ChangesAfter(ctx context.Context, groupID string, after, visibleFrom int64, limit int) (*Changes, error) {
	// Find the page boundary across both tables first, so that a page ends at
	// one sequence number and no later commit is skipped. Someone added without
	// the group's history gets its events from the commit that added them: what
	// came before is in their Welcome, and who did what when isn't theirs to see.
	rows, err := d.sql.QueryContext(ctx, `SELECT s FROM (
			SELECT updated_seq AS s FROM messages WHERE group_id = ?1 AND updated_seq > ?2 AND seq > ?3
			UNION ALL
			SELECT seq AS s FROM group_events WHERE group_id = ?1 AND seq > ?2 AND seq >= ?3
		) AS changes ORDER BY s ASC LIMIT ?4`, groupID, after, visibleFrom, limit+1)
	if err != nil {
		return nil, err
	}
	var seqs []int64
	for rows.Next() {
		var s int64
		if err := rows.Scan(&s); err != nil {
			rows.Close()
			return nil, err
		}
		seqs = append(seqs, s)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	changes := &Changes{Messages: []*Message{}, Events: []GroupEvent{}, Cursor: after}
	if len(seqs) == 0 {
		return changes, nil
	}
	if len(seqs) > limit {
		changes.HasMore = true
		seqs = seqs[:limit]
	}
	upTo := seqs[len(seqs)-1]
	changes.Cursor = upTo

	messageRows, err := d.sql.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages
		WHERE group_id = ? AND updated_seq > ? AND updated_seq <= ? AND seq > ? ORDER BY updated_seq ASC`, groupID, after, upTo, visibleFrom)
	if err != nil {
		return nil, err
	}
	changes.Messages, err = d.collectMessages(ctx, groupID, messageRows)
	if err != nil {
		return nil, err
	}

	eventRows, err := d.sql.QueryContext(ctx, `SELECT group_id, seq, kind, epoch, data, sender_user, sender_device, target_user, created_at, send_key
		FROM group_events WHERE group_id = ? AND seq > ? AND seq <= ? AND seq >= ? ORDER BY seq ASC`, groupID, after, upTo, visibleFrom)
	if err != nil {
		return nil, err
	}
	defer eventRows.Close()
	for eventRows.Next() {
		var e GroupEvent
		var senderDevice, target sql.NullString
		if err := eventRows.Scan(&e.GroupID, &e.Seq, &e.Kind, &e.Epoch, &e.Data, &e.SenderUser, &senderDevice, &target, &e.CreatedAt, &e.SendKey); err != nil {
			return nil, err
		}
		e.SenderDevice = senderDevice.String
		e.TargetUser = target.String
		changes.Events = append(changes.Events, e)
	}
	return changes, eventRows.Err()
}
