package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

func (d *DB) CreateSession(ctx context.Context, tokenHash []byte, userID string) error {
	now := Now()
	_, err := d.sql.ExecContext(ctx, `INSERT INTO sessions(token_hash, user_id, created_at, last_used_at) VALUES(?,?,?,?)`,
		tokenHash, userID, now, now)
	return err
}

// Session is an authenticated request's identity.
type Session struct {
	UserID   string
	DeviceID string
	Username string
	Role     string
}

const (
	// A session without a device is only the moment between signing in and
	// registering one. It appears nowhere the person could notice it, so it
	// doesn't get to last.
	devicelessSessionLife = 10 * time.Minute
	// A session nobody has used for this long is over.
	sessionIdleLife = 365 * 24 * time.Hour
	// When a session was last used is written at most this often.
	lastUsedResolution = time.Hour
)

func (d *DB) SessionByToken(ctx context.Context, tokenHash []byte) (*Session, error) {
	var s Session
	var device sql.NullString
	var createdAt, lastUsedAt int64
	err := d.sql.QueryRowContext(ctx, `SELECT s.user_id, s.device_id, u.username, u.role, s.created_at, s.last_used_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ? AND u.banned_at IS NULL`, tokenHash).Scan(&s.UserID, &device, &s.Username, &s.Role, &createdAt, &lastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	now := Now()
	if (!device.Valid && now-createdAt > devicelessSessionLife.Milliseconds()) || now-lastUsedAt > sessionIdleLife.Milliseconds() {
		return nil, ErrNotFound
	}
	if now-lastUsedAt > lastUsedResolution.Milliseconds() {
		if _, err := d.sql.ExecContext(ctx, `UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`, now, tokenHash); err != nil {
			return nil, err
		}
	}
	s.DeviceID = device.String
	return &s, nil
}

func (d *DB) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteExpiredSessions forgets sessions that no longer work.
func (d *DB) DeleteExpiredSessions(ctx context.Context) error {
	now := Now()
	_, err := d.sql.ExecContext(ctx, `DELETE FROM sessions WHERE (device_id IS NULL AND created_at < ?) OR last_used_at < ?`,
		now-devicelessSessionLife.Milliseconds(), now-sessionIdleLife.Milliseconds())
	return err
}

// SignInAttempts is what's kept of one account's sign-in attempts, as Unix milliseconds.
type SignInAttempts struct {
	Account  string
	Attempts int
	Until    int64
	Seen     int64
}

// RecentSignInAttempts lists the accounts tried since a moment.
func (d *DB) RecentSignInAttempts(ctx context.Context, since int64) ([]SignInAttempts, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT account, attempts, until_at, seen_at FROM sign_in_attempts WHERE seen_at >= ?`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SignInAttempts
	for rows.Next() {
		var a SignInAttempts
		if err := rows.Scan(&a.Account, &a.Attempts, &a.Until, &a.Seen); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (d *DB) SaveSignInAttempts(ctx context.Context, a SignInAttempts) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO sign_in_attempts(account, attempts, until_at, seen_at) VALUES(?,?,?,?)
		ON CONFLICT(account) DO UPDATE SET attempts = excluded.attempts, until_at = excluded.until_at, seen_at = excluded.seen_at`,
		a.Account, a.Attempts, a.Until, a.Seen)
	return err
}

// DeleteSignInAttemptsBefore forgets accounts nobody has tried since a moment.
func (d *DB) DeleteSignInAttemptsBefore(ctx context.Context, before int64) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM sign_in_attempts WHERE seen_at < ?`, before)
	return err
}

// --- Devices ---
