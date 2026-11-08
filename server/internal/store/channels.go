package store

import (
	"context"
	"database/sql"
	"errors"
)

// Most a server can have. A channel is an MLS group everyone's devices take part
// in, so each costs every device some work.
const maxChannels = 200

// Channel is a conversation everyone on a server can join: a group of kind
// "channel", with the same ID, that can be listed before joining it. The server
// can't read its name, which is sealed with the community key in Details.
type Channel struct {
	ID        string `json:"id"`
	Type      string `json:"type"` // "text" or "voice"
	Position  int64  `json:"position"`
	UserLimit int    `json:"user_limit"`
	// How many may share a screen at once: 0 leaves it to the server's rules, and -1 is nobody.
	ScreenLimit int    `json:"screen_limit"`
	Details     []byte `json:"details"`
	CreatedBy   string `json:"created_by"`
	CreatedAt   int64  `json:"created_at"`
	// Whether the soundboard can be played in a voice channel.
	Sounds bool `json:"sounds"`
	// Slow mode: how long each person waits between messages, in seconds, or 0. It
	// doesn't hold back the channel's admins.
	SlowMode int `json:"slow_mode"`
}

const channelColumns = `id, type, position, user_limit, screen_limit, details, created_by, created_at, sounds, slow_mode`

func scanChannel(row interface{ Scan(...any) error }) (*Channel, error) {
	var c Channel
	if err := row.Scan(&c.ID, &c.Type, &c.Position, &c.UserLimit, &c.ScreenLimit, &c.Details, &c.CreatedBy, &c.CreatedAt, &c.Sounds, &c.SlowMode); err != nil {
		return nil, err
	}
	return &c, nil
}

// Channels lists the server's channels, in the order admins put them.
func (d *DB) Channels(ctx context.Context) ([]*Channel, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+channelColumns+` FROM channels ORDER BY position, created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	channels := []*Channel{}
	for rows.Next() {
		channel, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, channel)
	}
	return channels, rows.Err()
}

func (d *DB) Channel(ctx context.Context, id string) (*Channel, error) {
	channel, err := scanChannel(d.sql.QueryRowContext(ctx, `SELECT `+channelColumns+` FROM channels WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return channel, err
}

// CreateChannel makes a channel at the end of the list, with its creator as its
// first member. Everyone else joins by themselves.
func (d *DB) CreateChannel(ctx context.Context, id, creator, channelType string, details []byte, userLimit, screenLimit int, sounds bool, slowMode int, proof []byte) (*Channel, error) {
	now := Now()
	err := d.tx(ctx, func(tx handle) error {
		var count, last int64
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(MAX(position), -1) FROM channels`).Scan(&count, &last); err != nil {
			return err
		}
		if count >= maxChannels {
			return ErrLimit
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO groups(id, kind, history_visible, created_by, created_at) VALUES(?, 'channel', 1, ?, ?)`, id, creator, now); err != nil {
			if isUniqueViolation(err) {
				return ErrConflict
			}
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO channels(id, type, position, user_limit, screen_limit, sounds, slow_mode, details, created_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
			id, channelType, last+1, userLimit, screenLimit, sounds, slowMode, details, creator, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO group_members(group_id, user_id, role, joined_at, proof) VALUES(?, ?, 'admin', ?, ?)`, id, creator, now, proof)
		return err
	})
	if err != nil {
		return nil, err
	}
	return d.Channel(ctx, id)
}

// UpdateChannel replaces a channel's sealed details and, if given, its limits, whether
// the soundboard plays there, and its slow mode.
func (d *DB) UpdateChannel(ctx context.Context, id string, details []byte, userLimit, screenLimit *int, sounds *bool, slowMode *int) error {
	res, err := d.sql.ExecContext(ctx, `UPDATE channels SET details = ?, user_limit = COALESCE(?, user_limit), screen_limit = COALESCE(?, screen_limit), sounds = COALESCE(?, sounds), slow_mode = COALESCE(?, slow_mode) WHERE id = ?`, details, userLimit, screenLimit, sounds, slowMode, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// takeSlowModeTurn refuses a message in a channel whose slow mode still holds its sender
// back, and otherwise notes when they sent it. The channel's admins aren't held back,
// and a group that isn't a channel has nothing to check.
func takeSlowModeTurn(ctx context.Context, tx handle, groupID, userID string, now int64) error {
	var slowMode int64
	var role string
	err := tx.QueryRowContext(ctx, `SELECT c.slow_mode, COALESCE(m.role, '') FROM channels c
		LEFT JOIN group_members m ON m.group_id = c.id AND m.user_id = ? WHERE c.id = ?`, userID, groupID).Scan(&slowMode, &role)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if slowMode > 0 && role != "admin" {
		var last int64
		switch err := tx.QueryRowContext(ctx, `SELECT sent_at FROM channel_sends WHERE channel_id = ? AND user_id = ?`, groupID, userID).Scan(&last); {
		case errors.Is(err, sql.ErrNoRows):
		case err != nil:
			return err
		case last+slowMode*1000 > now:
			return &SlowModeError{Wait: last + slowMode*1000 - now}
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO channel_sends(channel_id, user_id, sent_at) VALUES(?,?,?)
		ON CONFLICT(channel_id, user_id) DO UPDATE SET sent_at = excluded.sent_at`, groupID, userID, now)
	return err
}

// OrderChannels puts the listed channels in that order. Those left out, such as
// one made a moment ago, stay after them.
func (d *DB) OrderChannels(ctx context.Context, ids []string) error {
	return d.tx(ctx, func(tx handle) error {
		if _, err := tx.ExecContext(ctx, `UPDATE channels SET position = position + ?`, len(ids)); err != nil {
			return err
		}
		for position, id := range ids {
			if _, err := tx.ExecContext(ctx, `UPDATE channels SET position = ? WHERE id = ?`, position, id); err != nil {
				return err
			}
		}
		return nil
	})
}

// JoinChannel puts someone on a channel's roster, with the proof that they hold the
// community key, which other members check. All of a channel's history is theirs to
// read, if a member hands them its keys.
func (d *DB) JoinChannel(ctx context.Context, id, userID, role string, proof []byte, wantHistory bool) error {
	return d.tx(ctx, func(tx handle) error {
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels WHERE id = ?`, id).Scan(&exists); err != nil {
			return err
		}
		if exists == 0 {
			return ErrNotFound
		}
		var banned sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(banned_at, deleted_at) FROM users WHERE id = ?`, userID).Scan(&banned); err != nil {
			return err
		}
		if banned.Valid {
			return ErrForbidden
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO group_members(group_id, user_id, role, joined_at, proof, history_wanted)
			VALUES(?, ?, ?, ?, ?, ?)
			ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role, proof = excluded.proof,
				history_wanted = CASE WHEN excluded.history_wanted > group_members.history_wanted THEN excluded.history_wanted ELSE group_members.history_wanted END`,
			id, userID, role, Now(), proof, wantHistory)
		return err
	})
}

// AnswerHistoryRequest takes someone's request for a channel's older keys and keeps
// the keys sealed to them, together: false, with nothing kept, when someone else
// answered first. Either both happen or neither, so a request is never used up
// without its keys being there.
func (d *DB) AnswerHistoryRequest(ctx context.Context, groupID, userID string, data []byte) (bool, error) {
	var answered bool
	err := d.tx(ctx, func(tx handle) error {
		answered = false
		res, err := tx.ExecContext(ctx, `UPDATE group_members SET history_wanted = 0 WHERE group_id = ? AND user_id = ? AND history_wanted = 1`, groupID, userID)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil || n == 0 {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO history_grants(user_id, group_id, data, created_at) VALUES(?,?,?,?)`, userID, groupID, data, Now()); err != nil {
			return err
		}
		answered = true
		return nil
	})
	return answered, err
}

// SetChannelRoles makes someone's role in every channel follow their role on the server.
func (d *DB) SetChannelRoles(ctx context.Context, userID, role string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE group_members SET role = ? WHERE user_id = ? AND group_id IN (SELECT id FROM channels)`, role, userID)
	return err
}
