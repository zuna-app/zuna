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
	// What a message's reactions come to in all, which a full copy of it carries: room for
	// a few hundred real ones, each under 3 KiB with its signature.
	maxReactionBytesOnMessage = 1 << 20
	// Past this many reactions on a message, each takes a large token.
	reactionsOnSmallTokens = 100
	maxGroupsCreated      = 10_000
	maxActiveDevices      = 128
	maxDevicesEver        = 4096

	// A commit is kept this long and this far behind where its group has got to.
	// A device further behind than that rejoins, as one that's lost its place does.
	keepCommitsFor   = 30 * 24 * time.Hour
	keepCommitEpochs = 256

	// A history grant is a conversation's epoch keys sealed to someone (sealHistoryGrant in
	// the core): X-Wing's 1,120 bytes and the AEAD's tag, the signer's names, and its
	// device's hybrid signature, 2,485 bytes and 3,316 in base64, come to under 5 KiB, and
	// each epoch adds its key, 44 characters of base64 quoted in JSON quoted again in JSON,
	// 54 bytes and its number. Each is allowed over twice that, for as many epochs as the
	// conversation ever had, which is how many keys anyone in it can hold.
	grantBaseBytes     = 16 << 10
	grantBytesPerEpoch = 128
	// GrantsWaiting is how many grants of one conversation's history wait for one person,
	// the newest. A channel's request takes HistoryAnswers, and an app takes what's
	// waiting as soon as it's in the conversation, so only someone who asks again and
	// again without taking any, or is added over and over, ever has more.
	GrantsWaiting = 8

	storedBytes = "stored_bytes"
	commitBytes = "commit_bytes"
)

// MaxHistoryGrantBytes is the largest grant of a conversation's history whose epochs
// went as far as epoch.
func MaxHistoryGrantBytes(epoch int64) int {
	return grantBaseBytes + grantBytesPerEpoch*int(epoch+1)
}

// grantFits reports whether a grant could be one of a conversation's real ones: no
// larger than its epochs' keys, as far as it ever went, come to.
func grantFits(ctx context.Context, tx handle, groupID string, epoch int64, data []byte) (bool, error) {
	var top int64
	if err := tx.QueryRowContext(ctx, `SELECT CASE WHEN epoch > top_epoch THEN epoch ELSE top_epoch END FROM groups WHERE id = ?`, groupID).Scan(&top); err != nil {
		return false, err
	}
	if epoch > top {
		top = epoch
	}
	return len(data) <= MaxHistoryGrantBytes(top), nil
}

// keepNewestGrants leaves no more than GrantsWaiting of a conversation's grants waiting
// for someone, the newest, so that nobody can fill the disk with grants their recipient
// never takes, and the one handed on last still comes.
func keepNewestGrants(ctx context.Context, tx handle, userID, groupID string) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM history_grants WHERE user_id = ? AND group_id = ? AND id NOT IN
		(SELECT id FROM history_grants WHERE user_id = ? AND group_id = ? ORDER BY id DESC LIMIT ?)`,
		userID, groupID, userID, groupID, GrantsWaiting)
	return err
}

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
	snapshot, err := d.conn.BeginTx(d.sql.context(ctx, "BEGIN"), options)
	if err != nil {
		return err
	}
	defer snapshot.Rollback()
	read := handle{q: snapshot, postgres: d.postgres, hooks: d.hooks}
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
