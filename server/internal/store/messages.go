package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
)

// Message is an encrypted message and its server-visible state.
//
// Sync is state-based: every change to a message moves it to a new updated_seq,
// so a client that was offline fetches the current state of whatever changed
// instead of replaying each edit.
type Message struct {
	GroupID      string     `json:"group_id"`
	ID           string     `json:"id"`
	Seq          int64      `json:"seq"`
	UpdatedSeq   int64      `json:"updated_seq"`
	SenderUser   string     `json:"sender_user"`
	SenderDevice string     `json:"sender_device"`
	Epoch        int64      `json:"epoch"`
	Envelope     []byte     `json:"envelope,omitempty"`
	CreatedAt    int64      `json:"created_at"`
	EditedAt     *int64     `json:"edited_at"`
	DeletedAt    *int64     `json:"deleted_at"`
	PinnedAt     *int64     `json:"pinned_at"`
	PinnedBy     string     `json:"pinned_by,omitempty"`
	Reactions    []Reaction `json:"reactions"`
}

// Reaction is an encrypted reaction; the server can't tell which emote it is.
type Reaction struct {
	ID        string `json:"id"`
	UserID    string `json:"user_id"`
	Epoch     int64  `json:"epoch"`
	Data      []byte `json:"data"`
	CreatedAt int64  `json:"created_at"`
}

const messageColumns = `group_id, id, seq, updated_seq, sender_user, sender_device, epoch, envelope,
	created_at, edited_at, deleted_at, pinned_at, pinned_by`

func scanMessage(row interface{ Scan(...any) error }) (*Message, error) {
	var m Message
	var edited, deleted, pinned sql.NullInt64
	var pinnedBy sql.NullString
	if err := row.Scan(&m.GroupID, &m.ID, &m.Seq, &m.UpdatedSeq, &m.SenderUser, &m.SenderDevice, &m.Epoch, &m.Envelope,
		&m.CreatedAt, &edited, &deleted, &pinned, &pinnedBy); err != nil {
		return nil, err
	}
	m.EditedAt = nullableInt(edited)
	m.DeletedAt = nullableInt(deleted)
	m.PinnedAt = nullableInt(pinned)
	m.PinnedBy = pinnedBy.String
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
	rows, err := d.sql.QueryContext(ctx, `SELECT message_id, id, user_id, epoch, data, created_at FROM reactions
		WHERE group_id = ? AND message_id IN (`+placeholders(len(messages))+`) ORDER BY created_at`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID string
		var r Reaction
		if err := rows.Scan(&messageID, &r.ID, &r.UserID, &r.Epoch, &r.Data, &r.CreatedAt); err != nil {
			return err
		}
		byID[messageID].Reactions = append(byID[messageID].Reactions, r)
	}
	return rows.Err()
}

func currentEpoch(ctx context.Context, tx *sql.Tx, groupID string) (int64, error) {
	var epoch int64
	err := tx.QueryRowContext(ctx, `SELECT epoch FROM groups WHERE id = ?`, groupID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return epoch, err
}

// CreateMessage stores a message. Sending the same ID twice returns the
// existing message, which makes client retries safe. Content must be encrypted
// under the group's current epoch, so a removed member's key is never reused.
func (d *DB) CreateMessage(ctx context.Context, m Message, fileIDs []string) (*Message, error) {
	err := d.tx(ctx, func(tx *sql.Tx) error {
		var existing string
		err := tx.QueryRowContext(ctx, `SELECT sender_user FROM messages WHERE group_id = ? AND id = ?`, m.GroupID, m.ID).Scan(&existing)
		if err == nil {
			if existing != m.SenderUser {
				return ErrConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		epoch, err := currentEpoch(ctx, tx, m.GroupID)
		if err != nil {
			return err
		}
		if epoch != m.Epoch {
			return &EpochConflictError{Current: epoch}
		}
		seq, err := nextSeq(ctx, tx, m.GroupID)
		if err != nil {
			return err
		}
		now := Now()
		if _, err := tx.ExecContext(ctx, `INSERT INTO messages(group_id, id, seq, updated_seq, sender_user, sender_device, epoch, envelope, file_ids, created_at)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, m.GroupID, m.ID, seq, seq, m.SenderUser, m.SenderDevice, m.Epoch, m.Envelope,
			strings.Join(fileIDs, ","), now); err != nil {
			return err
		}
		for _, fileID := range fileIDs {
			if _, err := tx.ExecContext(ctx, `UPDATE files SET attached_at = ? WHERE id = ? AND owner_id = ?`, now, fileID, m.SenderUser); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return d.Message(ctx, m.GroupID, m.ID)
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

// EditMessage replaces a message's ciphertext. Only the sender may edit.
func (d *DB) EditMessage(ctx context.Context, groupID, id, userID, deviceID string, epoch int64, envelope []byte) (*Message, error) {
	err := d.tx(ctx, func(tx *sql.Tx) error {
		var sender string
		var deleted sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT sender_user, deleted_at FROM messages WHERE group_id = ? AND id = ?`, groupID, id).Scan(&sender, &deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if sender != userID || deleted.Valid {
			return ErrForbidden
		}
		current, err := currentEpoch(ctx, tx, groupID)
		if err != nil {
			return err
		}
		if current != epoch {
			return &EpochConflictError{Current: current}
		}
		seq, err := nextSeq(ctx, tx, groupID)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE messages SET envelope = ?, epoch = ?, sender_device = ?, edited_at = ?, updated_seq = ?
			WHERE group_id = ? AND id = ?`, envelope, epoch, deviceID, Now(), seq, groupID, id)
		return err
	})
	if err != nil {
		return nil, err
	}
	return d.Message(ctx, groupID, id)
}

// DeleteMessage erases the ciphertext and leaves a tombstone so every client
// removes it too. It returns the message and the files that are now orphaned.
func (d *DB) DeleteMessage(ctx context.Context, groupID, id string) (*Message, []string, error) {
	var fileIDs []string
	err := d.tx(ctx, func(tx *sql.Tx) error {
		var files string
		var deleted sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT file_ids, deleted_at FROM messages WHERE group_id = ? AND id = ?`, groupID, id).Scan(&files, &deleted)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if deleted.Valid {
			return nil
		}
		if files != "" {
			fileIDs = strings.Split(files, ",")
		}
		seq, err := nextSeq(ctx, tx, groupID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE group_id = ? AND message_id = ?`, groupID, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE messages SET envelope = NULL, file_ids = '', deleted_at = ?, pinned_at = NULL, pinned_by = NULL, updated_seq = ?
			WHERE group_id = ? AND id = ?`, Now(), seq, groupID, id)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	m, err := d.Message(ctx, groupID, id)
	return m, fileIDs, err
}

// touch moves a message to a new updated_seq after a change to its state.
func touch(ctx context.Context, tx *sql.Tx, groupID, id string) error {
	seq, err := nextSeq(ctx, tx, groupID)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE messages SET updated_seq = ? WHERE group_id = ? AND id = ?`, seq, groupID, id)
	return err
}

func messageExists(ctx context.Context, tx *sql.Tx, groupID, id string) error {
	var deleted sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT deleted_at FROM messages WHERE group_id = ? AND id = ?`, groupID, id).Scan(&deleted)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && deleted.Valid) {
		return ErrNotFound
	}
	return err
}

func (d *DB) AddReaction(ctx context.Context, groupID, messageID string, r Reaction) (*Message, error) {
	err := d.tx(ctx, func(tx *sql.Tx) error {
		if err := messageExists(ctx, tx, groupID, messageID); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO reactions(group_id, message_id, id, user_id, epoch, data, created_at)
			VALUES(?,?,?,?,?,?,?)`, groupID, messageID, r.ID, r.UserID, r.Epoch, r.Data, Now())
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

func (d *DB) RemoveReaction(ctx context.Context, groupID, messageID, reactionID, userID string) (*Message, error) {
	err := d.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE group_id = ? AND message_id = ? AND id = ? AND user_id = ?`,
			groupID, messageID, reactionID, userID)
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

func (d *DB) SetPinned(ctx context.Context, groupID, messageID, userID string, pinned bool) (*Message, error) {
	err := d.tx(ctx, func(tx *sql.Tx) error {
		if err := messageExists(ctx, tx, groupID, messageID); err != nil {
			return err
		}
		var err error
		if pinned {
			_, err = tx.ExecContext(ctx, `UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE group_id = ? AND id = ?`,
				Now(), userID, groupID, messageID)
		} else {
			_, err = tx.ExecContext(ctx, `UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE group_id = ? AND id = ?`,
				groupID, messageID)
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

// Pins returns pinned messages, newest pin first.
func (d *DB) Pins(ctx context.Context, groupID string, visibleFrom int64) ([]*Message, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages
		WHERE group_id = ? AND pinned_at IS NOT NULL AND seq > ? ORDER BY pinned_at DESC`, groupID, visibleFrom)
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

// MessagesAround returns the messages surrounding seq, oldest first, for
// jumping to a reply or search result.
func (d *DB) MessagesAround(ctx context.Context, groupID string, seq, visibleFrom int64, limit int) ([]*Message, error) {
	half := limit / 2
	older, err := d.MessagesBefore(ctx, groupID, seq+1, visibleFrom, half+1)
	if err != nil {
		return nil, err
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT `+messageColumns+` FROM messages
		WHERE group_id = ? AND seq > ? AND seq > ? ORDER BY seq ASC LIMIT ?`, groupID, seq, visibleFrom, half)
	if err != nil {
		return nil, err
	}
	newer, err := d.collectMessages(ctx, groupID, rows)
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
	// one sequence number and no later commit is skipped.
	rows, err := d.sql.QueryContext(ctx, `SELECT s FROM (
			SELECT updated_seq AS s FROM messages WHERE group_id = ?1 AND updated_seq > ?2 AND seq > ?3
			UNION ALL
			SELECT seq AS s FROM group_events WHERE group_id = ?1 AND seq > ?2
		) ORDER BY s ASC LIMIT ?4`, groupID, after, visibleFrom, limit+1)
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

	eventRows, err := d.sql.QueryContext(ctx, `SELECT group_id, seq, kind, epoch, data, sender_user, sender_device, target_user, created_at
		FROM group_events WHERE group_id = ? AND seq > ? AND seq <= ? ORDER BY seq ASC`, groupID, after, upTo)
	if err != nil {
		return nil, err
	}
	defer eventRows.Close()
	for eventRows.Next() {
		var e GroupEvent
		var senderDevice, target sql.NullString
		if err := eventRows.Scan(&e.GroupID, &e.Seq, &e.Kind, &e.Epoch, &e.Data, &e.SenderUser, &senderDevice, &target, &e.CreatedAt); err != nil {
			return nil, err
		}
		e.SenderDevice = senderDevice.String
		e.TargetUser = target.String
		changes.Events = append(changes.Events, e)
	}
	return changes, eventRows.Err()
}

// DeleteMessagesOlderThan applies the server's retention policy. It returns
// the files of the deleted messages.
func (d *DB) DeleteMessagesOlderThan(ctx context.Context, cutoff int64) ([]string, error) {
	var fileIDs []string
	err := d.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT file_ids FROM messages WHERE created_at < ? AND file_ids != '' AND pinned_at IS NULL`, cutoff)
		if err != nil {
			return err
		}
		for rows.Next() {
			var ids string
			if err := rows.Scan(&ids); err != nil {
				rows.Close()
				return err
			}
			fileIDs = append(fileIDs, strings.Split(ids, ",")...)
		}
		rows.Close()
		_, err = tx.ExecContext(ctx, `DELETE FROM messages WHERE created_at < ? AND pinned_at IS NULL`, cutoff)
		return err
	})
	return fileIDs, err
}

// --- Files ---

type File struct {
	ID          string `json:"id"`
	OwnerID     string `json:"owner_id"`
	ChunkCount  int    `json:"chunk_count"`
	TotalSize   int64  `json:"total_size"`
	CompletedAt *int64 `json:"completed_at"`
}

func (d *DB) CreateFile(ctx context.Context, f File) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO files(id, owner_id, chunk_count, total_size, created_at) VALUES(?,?,?,?,?)`,
		f.ID, f.OwnerID, f.ChunkCount, f.TotalSize, Now())
	return err
}

func (d *DB) File(ctx context.Context, id string) (*File, error) {
	var f File
	var completed sql.NullInt64
	err := d.sql.QueryRowContext(ctx, `SELECT id, owner_id, chunk_count, total_size, completed_at FROM files WHERE id = ?`, id).Scan(
		&f.ID, &f.OwnerID, &f.ChunkCount, &f.TotalSize, &completed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	f.CompletedAt = nullableInt(completed)
	return &f, err
}

func (d *DB) CompleteFile(ctx context.Context, id string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE files SET completed_at = ? WHERE id = ?`, Now(), id)
	return err
}

// AttachFile marks an upload as in use, which exempts it from cleanup.
func (d *DB) AttachFile(ctx context.Context, id, ownerID string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE files SET attached_at = ? WHERE id = ? AND owner_id = ?`, Now(), id, ownerID)
	return err
}

func (d *DB) DeleteFile(ctx context.Context, id string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM files WHERE id = ?`, id)
	return err
}

// UnattachedFiles lists uploads never attached to a message or profile.
func (d *DB) UnattachedFiles(ctx context.Context, olderThan int64) ([]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id FROM files WHERE attached_at IS NULL AND created_at < ?`, olderThan)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// --- Emotes ---

// Emote is one 7TV emote known to this server.
type Emote struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Animated  bool   `json:"animated"`
	ZeroWidth bool   `json:"zero_width"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	// Owner is the display name of whoever created the emote on 7TV.
	Owner string `json:"owner"`
}

// ReplaceEmoteSet makes emotes the current set. Emotes previously known stay
// in the table so old messages using them keep rendering.
func (d *DB) ReplaceEmoteSet(ctx context.Context, emotes []Emote) error {
	return d.tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE emotes SET in_set = 0`); err != nil {
			return err
		}
		for _, e := range emotes {
			if _, err := tx.ExecContext(ctx, `INSERT INTO emotes(id, name, animated, zero_width, width, height, owner, in_set)
				VALUES(?,?,?,?,?,?,?,1)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, animated = excluded.animated,
				zero_width = excluded.zero_width, width = excluded.width, height = excluded.height,
				owner = excluded.owner, in_set = 1`,
				e.ID, e.Name, e.Animated, e.ZeroWidth, e.Width, e.Height, e.Owner); err != nil {
				return err
			}
		}
		return nil
	})
}

func (d *DB) EmoteSet(ctx context.Context) ([]Emote, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, name, animated, zero_width, width, height, owner FROM emotes WHERE in_set = 1 ORDER BY name COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	emotes := []Emote{}
	for rows.Next() {
		var e Emote
		if err := rows.Scan(&e.ID, &e.Name, &e.Animated, &e.ZeroWidth, &e.Width, &e.Height, &e.Owner); err != nil {
			return nil, err
		}
		emotes = append(emotes, e)
	}
	return emotes, rows.Err()
}

func (d *DB) EmoteKnown(ctx context.Context, id string) (bool, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM emotes WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}
