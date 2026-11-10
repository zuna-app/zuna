package store

import (
	"context"
	"slices"
	"strconv"
)

// DeleteMessagesOlderThan applies the server's retention policy. It returns
// the files no message uses any more, including on an error, for the batches
// that were deleted before it.
func (d *DB) DeleteMessagesOlderThan(ctx context.Context, cutoff int64) ([]string, error) {
	return d.deleteMessagesWhere(ctx, retentionBatch(), cutoff)
}

// DeleteExpiredMessages removes the disappearing messages that are due by now,
// pinned or not. It returns the files no message uses any more, as
// DeleteMessagesOlderThan does.
func (d *DB) DeleteExpiredMessages(ctx context.Context, now int64) ([]string, error) {
	return d.deleteMessagesWhere(ctx, expiryBatch(), now)
}

// deleteBatch is how many messages one transaction deletes. The first delete
// after retention is turned on can reach most of a server's messages, and one
// transaction for all of them would hold SQLite's write lock past every other
// writer's busy timeout, or be a serializable transaction in PostgreSQL bound
// to collide.
var deleteBatch = 1000

// retentionBatch and expiryBatch pick a batch of messages to delete. Each goes in
// the order of the indexed column it picks by: in any other, such as the primary
// key's, SQLite would read every message to fill a batch, with the write lock
// held, whenever fewer than a batch are due, as they are nearly every time.
func retentionBatch() string {
	return `SELECT group_id, id FROM messages WHERE created_at < ? AND pinned_at IS NULL ORDER BY created_at LIMIT ` + strconv.Itoa(deleteBatch)
}

func expiryBatch() string {
	return `SELECT group_id, id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ` + strconv.Itoa(deleteBatch)
}

// deleteMessagesWhere deletes the messages a batch query on one argument picks,
// a batch at a time, and returns the files no message uses any more.
func (d *DB) deleteMessagesWhere(ctx context.Context, batch string, arg int64) ([]string, error) {
	var removed []string
	for {
		var fileIDs []string
		var deleted int64
		err := d.tx(ctx, func(tx handle) error {
			used, err := collectStrings(ctx, tx, `SELECT DISTINCT file_id FROM file_refs WHERE (group_id, message_id) IN (`+batch+`)`, arg)
			if err != nil {
				return err
			}
			result, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE (group_id, id) IN (`+batch+`)`, arg)
			if err != nil {
				return err
			}
			if deleted, err = result.RowsAffected(); err != nil {
				return err
			}
			fileIDs, err = unreferenced(ctx, tx, used)
			return err
		})
		if err != nil {
			return removed, err
		}
		removed = append(removed, fileIDs...)
		if deleted < int64(deleteBatch) {
			return removed, nil
		}
		if err := ctx.Err(); err != nil {
			return removed, err
		}
	}
}

func collectStrings(ctx context.Context, tx handle, query string, args ...any) ([]string, error) {
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var values []string
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}

// unreferenced keeps the files nothing uses any more. A forwarded message shares
// its original's files, so they stay until the last copy is gone, and someone's
// picture or a group's stays whatever messages come and go.
func unreferenced(ctx context.Context, tx handle, fileIDs []string) ([]string, error) {
	var orphaned []string
	for _, id := range fileIDs {
		if slices.Contains(orphaned, id) {
			continue
		}
		var used bool
		err := tx.QueryRowContext(ctx, `SELECT
			EXISTS(SELECT 1 FROM file_refs WHERE file_id = ?1) OR
			EXISTS(SELECT 1 FROM users WHERE avatar_file = ?1) OR
			EXISTS(SELECT 1 FROM files WHERE id = ?1 AND standalone = 1)`, id).Scan(&used)
		if err != nil {
			return nil, err
		}
		if !used {
			orphaned = append(orphaned, id)
		}
	}
	return orphaned, nil
}

// inSeenMessage is true when file ?1 is in a message user ?2 can see, in a
// conversation they belong to: one sent after they could see it from, which is who may read it.
const inSeenMessage = `EXISTS(SELECT 1 FROM file_refs r JOIN group_members m ON m.group_id = r.group_id
	JOIN messages msg ON msg.group_id = r.group_id AND msg.id = r.message_id
	WHERE r.file_id = ?1 AND m.user_id = ?2 AND msg.seq > m.visible_from_seq)`


// --- Files ---
