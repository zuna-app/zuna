package store

import (
	"context"
	"database/sql"
	"time"
)

// What one person can make the server keep, beyond their files. All of it is far
// past what using the app comes to, and is there so that nobody can fill a disk.
const (
	maxCommitBytes = 1 << 30
	// A commit and its group info, which holds the group's whole tree.
	commitBaseBytes      = 256 << 10
	commitBytesPerDevice = 8 << 10

	maxReactionsOnMessage = 1024
	maxGroupsCreated      = 10_000
	maxActiveDevices      = 128
	maxDevicesEver        = 4096

	// A commit is kept this long and this far behind where its group has got to.
	// A device further behind than that rejoins, as one that's lost its place does.
	keepCommitsFor   = 30 * 24 * time.Hour
	keepCommitEpochs = 256

	storedBytes = "stored_bytes"
	commitBytes = "commit_bytes"
)

// countBytes adds to one of someone's running totals, unless that would take them
// past limit, where zero is no limit.
func countBytes(ctx context.Context, tx handle, column, userID string, n, limit int64) error {
	if limit <= 0 {
		_, err := tx.ExecContext(ctx, `UPDATE users SET `+column+` = `+column+` + ? WHERE id = ?`, n, userID)
		return err
	}
	res, err := tx.ExecContext(ctx, `UPDATE users SET `+column+` = `+column+` + ?1 WHERE id = ?2 AND `+column+` + ?1 <= ?3`, n, userID, limit)
	if err != nil {
		return err
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return ErrQuota
	}
	return nil
}

// RecountStorage works out again what everyone has stored, since the running totals
// only ever go up. What one person keeps is their vault: a message or a reaction
// names nobody, so it's held by tokens instead, and a file by what they upload.
//
// It counts, and reads the totals, in one read-only snapshot, which keeps no writer
// waiting, then moves each total that's off by the difference. Whatever was added
// since the snapshot stays added, and only those rows are written.
func (d *DB) RecountStorage(ctx context.Context) error {
	options := &sql.TxOptions{ReadOnly: true}
	if d.postgres {
		options.Isolation = sql.LevelRepeatableRead
	}
	snapshot, err := d.conn.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer snapshot.Rollback()
	read := handle{snapshot, d.postgres, nil}
	stored := map[string]int64{}
	commits := map[string]int64{}
	add := func(totals map[string]int64, query string) error {
		rows, err := read.QueryContext(ctx, query)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var user string
			var n int64
			if err := rows.Scan(&user, &n); err != nil {
				return err
			}
			totals[user] += n
		}
		return rows.Err()
	}
	if err := add(stored, `SELECT user_id, COALESCE(SUM(LENGTH(data)), 0) FROM vault_items GROUP BY user_id`); err != nil {
		return err
	}
	if err := add(commits, `SELECT sender_user, COALESCE(SUM(LENGTH(data) + COALESCE(LENGTH(replaced_info), 0)), 0)
		FROM group_events WHERE kind = 'commit' GROUP BY sender_user`); err != nil {
		return err
	}
	type change struct {
		user            string
		stored, commits int64
	}
	var changes []change
	rows, err := read.QueryContext(ctx, `SELECT id, stored_bytes, commit_bytes FROM users`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var user string
		var heldStored, heldCommits int64
		if err := rows.Scan(&user, &heldStored, &heldCommits); err != nil {
			rows.Close()
			return err
		}
		if c := (change{user, stored[user] - heldStored, commits[user] - heldCommits}); c.stored != 0 || c.commits != 0 {
			changes = append(changes, c)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	snapshot.Rollback()
	if len(changes) == 0 {
		return nil
	}
	return d.tx(ctx, func(tx handle) error {
		for _, c := range changes {
			if _, err := tx.ExecContext(ctx, `UPDATE users SET stored_bytes = stored_bytes + ?, commit_bytes = commit_bytes + ? WHERE id = ?`,
				c.stored, c.commits, c.user); err != nil {
				return err
			}
		}
		return nil
	})
}

// prunableCommits picks the commits PruneCommits deletes, through group_events_commits.
const prunableCommits = `kind = 'commit' AND created_at < ?
	AND epoch <= (SELECT epoch FROM groups WHERE groups.id = group_events.group_id) - ?`

// PruneCommits forgets commits nobody should still need.
func (d *DB) PruneCommits(ctx context.Context) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM group_events WHERE `+prunableCommits,
		time.Now().Add(-keepCommitsFor).UnixMilli(), keepCommitEpochs)
	return err
}

// commitDevices is how many devices a commit's size can reasonably go by: those of
// the people in the group, and of whoever it's adding.
func commitDevices(ctx context.Context, tx handle, groupID string, adding []string) (int64, error) {
	args := []any{groupID}
	query := `SELECT COUNT(*) FROM devices WHERE revoked_at IS NULL AND user_id IN (SELECT user_id FROM group_members WHERE group_id = ?`
	if len(adding) > 0 {
		query += ` UNION SELECT id FROM users WHERE id IN (` + placeholders(len(adding)) + `)`
		for _, user := range adding {
			args = append(args, user)
		}
	}
	var n int64
	err := tx.QueryRowContext(ctx, query+`)`, args...).Scan(&n)
	return n, err
}
