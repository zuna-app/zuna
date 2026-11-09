package store

import (
	"context"
	"database/sql"
	"errors"
)

// VaultItem is an opaque blob, encrypted under the user's account key of its
// generation. The generation is only a hint: a wrong one makes it fail to open.
type VaultItem struct {
	ID         string `json:"id"`
	Seq        int64  `json:"seq"`
	Generation int64  `json:"generation"`
	Data       []byte `json:"data"`
	// Version, if not 0, has to be above the stored item's.
	Version int64 `json:"version,omitempty"`
}

func countVaultItems(ctx context.Context, tx handle, userID string, items []VaultItem, quota int64) error {
	var size int64
	for _, item := range items {
		size += int64(len(item.Data))
	}
	return countBytes(ctx, tx, storedBytes, userID, size, quota)
}

func putItems(ctx context.Context, tx handle, userID string, items []VaultItem) error {
	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM vault_items WHERE user_id = ?`, userID).Scan(&seq); err != nil {
		return err
	}
	for _, item := range items {
		if item.Version > 0 {
			var held int64
			err := tx.QueryRowContext(ctx, `SELECT version FROM vault_items WHERE user_id = ? AND id = ?`, userID, item.ID).Scan(&held)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if item.Version <= held {
				return ErrStaleVersion
			}
		}
		seq++
		if _, err := tx.ExecContext(ctx, `INSERT INTO vault_items(user_id, id, seq, generation, data, version) VALUES(?,?,?,?,?,?)
			ON CONFLICT(user_id, id) DO UPDATE SET seq = excluded.seq, generation = excluded.generation, data = excluded.data, version = excluded.version`,
			userID, item.ID, seq, item.Generation, item.Data, item.Version); err != nil {
			return err
		}
	}
	return nil
}

// KeyGeneration is which generation of its keys an account is at.
func (d *DB) KeyGeneration(ctx context.Context, userID string) (int64, error) {
	var generation int64
	err := d.sql.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, userID).Scan(&generation)
	return generation, err
}

// --- Invites ---
