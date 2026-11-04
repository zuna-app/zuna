package store

import (
	"context"
	"database/sql"
	"errors"
)

// Most a server can have. Every device fetches all of them.
const maxSounds = 50

// Sound is one sound on a server's soundboard. The server can't read what it's
// called or open its file, as both are in Details, sealed with the community key.
type Sound struct {
	ID        string `json:"id"`
	Details   []byte `json:"details"`
	FileID    string `json:"-"`
	CreatedBy string `json:"created_by"`
	CreatedAt int64  `json:"created_at"`
}

const soundColumns = `id, details, file_id, created_by, created_at`

func scanSound(row interface{ Scan(...any) error }) (*Sound, error) {
	var s Sound
	if err := row.Scan(&s.ID, &s.Details, &s.FileID, &s.CreatedBy, &s.CreatedAt); err != nil {
		return nil, err
	}
	return &s, nil
}

// Sounds lists the soundboard, oldest first.
func (d *DB) Sounds(ctx context.Context) ([]*Sound, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+soundColumns+` FROM sounds ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sounds := []*Sound{}
	for rows.Next() {
		sound, err := scanSound(rows)
		if err != nil {
			return nil, err
		}
		sounds = append(sounds, sound)
	}
	return sounds, rows.Err()
}

func (d *DB) Sound(ctx context.Context, id string) (*Sound, error) {
	sound, err := scanSound(d.sql.QueryRowContext(ctx, `SELECT `+soundColumns+` FROM sounds WHERE id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return sound, err
}

// CreateSound adds a sound at the end of the soundboard, unless it's full.
func (d *DB) CreateSound(ctx context.Context, sound Sound) (*Sound, error) {
	sound.CreatedAt = Now()
	err := d.tx(ctx, func(tx *sql.Tx) error {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM sounds`).Scan(&count); err != nil {
			return err
		}
		if count >= maxSounds {
			return ErrLimit
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO sounds(`+soundColumns+`) VALUES(?,?,?,?,?)`, sound.ID, sound.Details, sound.FileID, sound.CreatedBy, sound.CreatedAt)
		if isUniqueViolation(err) {
			return ErrConflict
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return &sound, nil
}

// UpdateSound replaces what a sound's sealed details say. Its file stays.
func (d *DB) UpdateSound(ctx context.Context, id string, details []byte) error {
	res, err := d.sql.ExecContext(ctx, `UPDATE sounds SET details = ? WHERE id = ?`, details, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteSound takes a sound off the soundboard, and says which file it leaves behind.
func (d *DB) DeleteSound(ctx context.Context, id string) (string, error) {
	var fileID string
	err := d.sql.QueryRowContext(ctx, `DELETE FROM sounds WHERE id = ? RETURNING file_id`, id).Scan(&fileID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return fileID, err
}
