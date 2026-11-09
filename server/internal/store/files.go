package store

import (
	"context"
	"database/sql"
	"errors"
)

type File struct {
	ID          string `json:"id"`
	OwnerID     string `json:"owner_id,omitempty"`
	ChunkCount  int    `json:"chunk_count"`
	TotalSize   int64  `json:"total_size"`
	CompletedAt *int64 `json:"completed_at"`
	// Received is how much of the upload has arrived so far.
	Received int64 `json:"-"`
}

// CreateFile records a new upload, unless that would take its owner past quota,
// where zero is no limit. Both happen in one transaction, so uploads started
// together can't each get past it.
func (d *DB) CreateFile(ctx context.Context, f File, quota int64) error {
	return d.tx(ctx, func(tx handle) error {
		if quota > 0 {
			var used int64
			if err := tx.QueryRowContext(ctx, `SELECT CAST(COALESCE(SUM(CASE WHEN total_size > received THEN total_size ELSE received END), 0) AS BIGINT) FROM files WHERE owner_id = ?`, f.OwnerID).Scan(&used); err != nil {
				return err
			}
			if used+f.TotalSize > quota {
				return ErrQuota
			}
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO files(id, owner_id, chunk_count, total_size, created_at) VALUES(?,?,?,?,?)`,
			f.ID, f.OwnerID, f.ChunkCount, f.TotalSize, Now())
		return err
	})
}

func (d *DB) File(ctx context.Context, id string) (*File, error) {
	var f File
	var completed sql.NullInt64
	err := d.sql.QueryRowContext(ctx, `SELECT id, owner_id, chunk_count, total_size, completed_at, received FROM files WHERE id = ?`, id).Scan(
		&f.ID, &f.OwnerID, &f.ChunkCount, &f.TotalSize, &completed, &f.Received)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	f.CompletedAt = nullableInt(completed)
	return &f, err
}

// MayReadFile reports whether a user may read a file: their own, someone's
// picture, or one in a message they can see, in a conversation they belong to.
func (d *DB) MayReadFile(ctx context.Context, fileID, userID string) (bool, error) {
	var allowed bool
	err := d.sql.QueryRowContext(ctx, `SELECT
		EXISTS(SELECT 1 FROM files WHERE id = ?1 AND (owner_id = ?2 OR standalone = 1)) OR
		EXISTS(SELECT 1 FROM users WHERE avatar_file = ?1) OR `+inSeenMessage, fileID, userID).Scan(&allowed)
	return allowed, err
}

// AddReceived records a part of an upload arriving, which may replace an
// earlier copy of the same part.
func (d *DB) AddReceived(ctx context.Context, id string, bytes int64) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE files SET received = received + ?, touched_at = ? WHERE id = ?`, bytes, Now(), id)
	return err
}

func (d *DB) CompleteFile(ctx context.Context, id string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE files SET completed_at = ? WHERE id = ?`, Now(), id)
	return err
}

// AttachFile marks an upload as standing on its own, such as a group's picture,
// which exempts it from cleanup.
func (d *DB) AttachFile(ctx context.Context, id, ownerID string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE files SET attached_at = ?, standalone = 1 WHERE id = ? AND owner_id = ?`, Now(), id, ownerID)
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

// AbandonedUploads lists uploads that stopped before finishing, with nothing
// arriving since the given time.
func (d *DB) AbandonedUploads(ctx context.Context, idleSince int64) ([]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id FROM files WHERE completed_at IS NULL AND attached_at IS NULL AND COALESCE(touched_at, created_at) < ?`, idleSince)
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
