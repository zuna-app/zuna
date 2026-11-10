package store

import (
	"context"
	"database/sql"
	"errors"
)

func nextSeq(ctx context.Context, tx handle, groupID string) (int64, error) {
	var seq int64
	err := tx.QueryRowContext(ctx, `UPDATE groups SET seq = seq + 1 WHERE id = ? RETURNING seq`, groupID).Scan(&seq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return seq, err
}

// ApplyCommit advances a group by one epoch if the commit was built on the
// current one. This compare-and-swap is the total ordering MLS requires from
// its delivery service. It returns the stored event.
func (d *DB) ApplyCommit(ctx context.Context, c Commit) (*GroupEvent, error) {
	var event GroupEvent
	err := d.tx(ctx, func(tx handle) error {
		c := c // Each attempt starts from the commit as it was sent.
		var epoch int64
		var kind string
		var replaced, replacedKey []byte
		err := tx.QueryRowContext(ctx, `SELECT g.epoch, g.kind, i.info, i.send_key FROM groups g LEFT JOIN group_infos i ON i.group_id = g.id
			WHERE g.id = ?`, c.GroupID).Scan(&epoch, &kind, &replaced, &replacedKey)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if epoch != c.ExpectedEpoch {
			return &EpochConflictError{Current: epoch}
		}
		var role string
		err = tx.QueryRowContext(ctx, `SELECT role FROM group_members WHERE group_id = ? AND user_id = ?`,
			c.GroupID, c.SenderUser).Scan(&role)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		if (len(c.AddUsers) > 0 || len(c.RemoveUsers) > 0) && role != "admin" {
			return ErrForbidden
		}
		// Who's in a channel is up to each person, and only a ban takes them out.
		if kind != "group" && (len(c.AddUsers) > 0 || len(c.RemoveUsers) > 0) {
			return ErrForbidden
		}
		if c.Admins != nil && (role != "admin" || kind != "group") {
			return ErrForbidden
		}
		// A device that has only just stopped being an admin may still send the
		// details, so a member's copy is left out instead of refusing the commit.
		if role != "admin" {
			c.Meta = nil
		}
		if err := checkCommitExtras(ctx, tx, c, role); err != nil {
			return err
		}
		if err := countCommit(ctx, tx, c); err != nil {
			return err
		}

		seq, err := nextSeq(ctx, tx, c.GroupID)
		if err != nil {
			return err
		}
		now := Now()
		var visibleFrom int64 = seq
		senderAdmin := false
		if len(c.AddUsers) > 0 {
			var serverRole string
			if err := tx.QueryRowContext(ctx, `SELECT role FROM users WHERE id = ?`, c.SenderUser).Scan(&serverRole); err != nil {
				return err
			}
			senderAdmin = serverRole == "owner" || serverRole == "admin"
		}
		for _, user := range c.AddUsers {
			var banned sql.NullInt64
			if err := tx.QueryRowContext(ctx, `SELECT COALESCE(banned_at, deleted_at) FROM users WHERE id = ?`, user).Scan(&banned); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return ErrNotFound
				}
				return err
			}
			if banned.Valid {
				return ErrForbidden
			}
			// A bot comes into a group only through someone its owner lets add it.
			bot, err := botRules(ctx, tx, user)
			if err != nil {
				return err
			}
			if bot != nil {
				if !bot.MayBeAddedBy(c.SenderUser, senderAdmin) {
					return ErrForbidden
				}
				// Everyone in the group lists it from now on, a private one too.
				if _, err := tx.ExecContext(ctx, `UPDATE users SET updated_at = ? WHERE id = ?`, now, user); err != nil {
					return err
				}
			}
			// New members can only see messages sent after they joined, unless
			// an admin handed them the older epoch keys with a history grant.
			// A bot never gets anything from before.
			from := visibleFrom
			for _, grant := range c.HistoryGrants {
				if grant.UserID == user {
					if bot != nil {
						return ErrForbidden
					}
					from = 0
				}
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO group_members(group_id, user_id, role, joined_at, visible_from_seq)
				VALUES(?, ?, 'member', ?, ?)
				ON CONFLICT(group_id, user_id) DO UPDATE SET visible_from_seq = excluded.visible_from_seq`,
				c.GroupID, user, now, from); err != nil {
				return err
			}
		}
		for _, user := range c.RemoveUsers {
			if _, err := tx.ExecContext(ctx, `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, c.GroupID, user); err != nil {
				return err
			}
		}
		if c.Admins != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE group_members SET role = 'member' WHERE group_id = ?`, c.GroupID); err != nil {
				return err
			}
			for _, user := range *c.Admins {
				if _, err := tx.ExecContext(ctx, `UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?`, c.GroupID, user); err != nil {
					return err
				}
			}
		}
		newEpoch := c.ExpectedEpoch + 1
		if c.Meta != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE groups SET epoch = ?, meta = ?, meta_epoch = ? WHERE id = ?`,
				newEpoch, c.Meta, c.MetaEpoch, c.GroupID); err != nil {
				return err
			}
		} else {
			if _, err := tx.ExecContext(ctx, `UPDATE groups SET epoch = ? WHERE id = ?`, newEpoch, c.GroupID); err != nil {
				return err
			}
		}
		if err := setGroupInfo(ctx, tx, c.GroupID, c.GroupInfo, c.SendKey); err != nil {
			return err
		}
		for _, welcome := range c.Welcomes {
			if _, err := tx.ExecContext(ctx, `INSERT INTO welcomes(device_id, group_id, data, created_at) VALUES(?,?,?,?)`,
				welcome.DeviceID, c.GroupID, welcome.Data, now); err != nil {
				return err
			}
		}
		for _, grant := range c.HistoryGrants {
			if _, err := tx.ExecContext(ctx, `INSERT INTO history_grants(user_id, group_id, data, created_at) VALUES(?,?,?,?)`,
				grant.UserID, c.GroupID, grant.Data, now); err != nil {
				return err
			}
		}
		event = GroupEvent{
			GroupID:      c.GroupID,
			Seq:          seq,
			Kind:         "commit",
			Epoch:        newEpoch,
			Data:         c.Data,
			SenderUser:   c.SenderUser,
			SenderDevice: c.SenderDevice,
			CreatedAt:    now,
			SendKey:      c.SendKey,
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO group_events(group_id, seq, kind, epoch, data, sender_user, sender_device, created_at, replaced_info, send_key, replaced_send_key)
			VALUES(?,?,?,?,?,?,?,?,?,?,?)`, c.GroupID, seq, "commit", newEpoch, c.Data, c.SenderUser, c.SenderDevice, now, replaced, c.SendKey, replacedKey)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE group_events SET replaced_info = NULL, replaced_send_key = NULL WHERE group_id = ? AND epoch <= ? AND replaced_info IS NOT NULL`,
			c.GroupID, newEpoch-UndoableCommits)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &event, nil
}

// countCommit holds a commit to a size that goes with the group it's for, and counts
// everything it makes the server keep for its sender.
func countCommit(ctx context.Context, tx handle, c Commit) error {
	devices, err := commitDevices(ctx, tx, c.GroupID, c.AddUsers)
	if err != nil {
		return err
	}
	size := int64(len(c.Data) + len(c.GroupInfo))
	if size > commitBaseBytes+commitBytesPerDevice*devices {
		return ErrLimit
	}
	for _, welcome := range c.Welcomes {
		size += int64(len(welcome.Data))
	}
	for _, grant := range c.HistoryGrants {
		size += int64(len(grant.Data))
	}
	limit := int64(maxCommitBytes)
	if c.Quota > 0 && c.Quota < limit {
		limit = c.Quota
	}
	return countBytes(ctx, tx, commitBytes, c.SenderUser, size, limit)
}

// checkCommitExtras holds a commit's welcomes and history grants to what the
// commit is doing: welcomes go to the devices of people joining (and, when a
// group starts, of its members), and only admins hand history to people joining.
func checkCommitExtras(ctx context.Context, tx handle, c Commit, role string) error {
	joining := map[string]bool{}
	for _, user := range c.AddUsers {
		joining[user] = true
	}
	for _, grant := range c.HistoryGrants {
		if role != "admin" || !joining[grant.UserID] {
			return ErrForbidden
		}
	}
	if c.ExpectedEpoch == 0 {
		rows, err := tx.QueryContext(ctx, `SELECT user_id FROM group_members WHERE group_id = ?`, c.GroupID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var user string
			if err := rows.Scan(&user); err != nil {
				return err
			}
			joining[user] = true
		}
		if err := rows.Err(); err != nil {
			return err
		}
	}
	for _, welcome := range c.Welcomes {
		var owner string
		err := tx.QueryRowContext(ctx, `SELECT user_id FROM devices WHERE id = ? AND revoked_at IS NULL`, welcome.DeviceID).Scan(&owner)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !joining[owner]) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// UndoableCommits is how many of a group's latest commits a plain member can undo.
// It's more than anyone can send in a burst, so that one person's run of them can
// always be undone by whoever is still at the epoch before.
const UndoableCommits = 32

// VoidCommits takes a group back to an earlier epoch, after a commit nobody can
// apply. Members who never got past that epoch simply carry on from it; one who
// did rejoins. Only `from`, the epoch the group is at, can be voided, so someone
// acting on old information changes nothing.
//
// An admin says what to go back to. Anyone else can only go back over other plain
// members' commits, to the group info the server held then. Taking theirs instead
// would let one member's undo leave everyone with nothing they could rejoin from.
// It returns who sent the commits undone, starting from the latest.
//
// The send key goes back with the group info: an admin gives the one for the epoch
// it goes back to, and anyone else gets the one the server held then.
func (d *DB) VoidCommits(ctx context.Context, groupID, sender, senderDevice string, byAdmin bool, from, to int64, groupInfo, sendKey []byte) (*GroupEvent, []string, error) {
	var event GroupEvent
	var senders []string
	err := d.tx(ctx, func(tx handle) error {
		current, err := currentEpoch(ctx, tx, groupID)
		if err != nil {
			return err
		}
		if current != from {
			return &EpochConflictError{Current: current}
		}
		var anyAdmin bool
		senders, anyAdmin, err = commitSenders(ctx, tx, groupID, to)
		if err != nil {
			return err
		}
		if !byAdmin {
			if anyAdmin {
				return ErrForbidden
			}
			var held, heldKey []byte
			err := tx.QueryRowContext(ctx, `SELECT replaced_info, replaced_send_key FROM group_events WHERE group_id = ? AND kind = 'commit' AND epoch = ?`,
				groupID, to+1).Scan(&held, &heldKey)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && len(held) == 0 && to != 0) {
				return ErrForbidden
			}
			if err != nil {
				return err
			}
			groupInfo, sendKey = held, heldKey
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM group_events WHERE group_id = ? AND kind = 'commit' AND epoch > ?`, groupID, to); err != nil {
			return err
		}
		// With nothing to go back to, the group starts again from nothing.
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET epoch = ? WHERE id = ?`, to, groupID); err != nil {
			return err
		}
		if err := setGroupInfo(ctx, tx, groupID, groupInfo, sendKey); err != nil {
			return err
		}
		seq, err := nextSeq(ctx, tx, groupID)
		if err != nil {
			return err
		}
		event = GroupEvent{
			GroupID: groupID, Seq: seq, Kind: "commit_voided", Epoch: to,
			SenderUser: sender, SenderDevice: senderDevice, CreatedAt: Now(),
		}
		var target any
		if len(senders) > 0 {
			event.TargetUser = senders[0]
			target = senders[0]
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO group_events(group_id, seq, kind, epoch, sender_user, sender_device, target_user, created_at)
			VALUES(?,?,?,?,?,?,?,?)`, groupID, seq, "commit_voided", to, sender, senderDevice, target, event.CreatedAt)
		return err
	})
	if err != nil {
		return nil, nil, err
	}
	return &event, senders, nil
}

// commitSenders is who sent a group's commits past an epoch, latest first, and
// whether any of them is an admin of it now.
func commitSenders(ctx context.Context, tx handle, groupID string, after int64) ([]string, bool, error) {
	rows, err := tx.QueryContext(ctx, `SELECT e.sender_user, COALESCE(m.role, '') FROM group_events e
		LEFT JOIN group_members m ON m.group_id = e.group_id AND m.user_id = e.sender_user
		WHERE e.group_id = ? AND e.kind = 'commit' AND e.epoch > ? ORDER BY e.epoch DESC`, groupID, after)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	var senders []string
	anyAdmin := false
	seen := map[string]bool{}
	for rows.Next() {
		var user, role string
		if err := rows.Scan(&user, &role); err != nil {
			return nil, false, err
		}
		anyAdmin = anyAdmin || role == "admin"
		if !seen[user] {
			seen[user] = true
			senders = append(senders, user)
		}
	}
	return senders, anyAdmin, rows.Err()
}

// setGroupInfo keeps a group's latest GroupInfo and its epoch's send key, or none.
// It's in a table of its own, as it carries the group's whole ratchet tree, which
// grows with each device in it: in the group's row, SQLite would write it again with
// each message, which changes the row's seq, and read past it for anything after it in the row.
func setGroupInfo(ctx context.Context, tx handle, groupID string, info, sendKey []byte) error {
	if len(info) == 0 {
		_, err := tx.ExecContext(ctx, `DELETE FROM group_infos WHERE group_id = ?`, groupID)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO group_infos(group_id, info, send_key) VALUES(?, ?, ?)
		ON CONFLICT(group_id) DO UPDATE SET info = excluded.info, send_key = excluded.send_key`, groupID, info, sendKey)
	return err
}

// SendKeyLen is how long a send key's public half is: an Ed25519 key's.
const SendKeyLen = 32

// A send key is every device's in its epoch's tree, and a device leaves the tree only
// by a commit. One that goes any other way, with its person leaving or being banned, or
// by being signed out, still makes the key until a member's commit takes its leaf out.
// So the server forgets the key there and then, and takes nothing sealed for the group
// until that commit gives it the next epoch's, which the device that went can't make.

// voidSendKey forgets a group's send key, as someone leaves it without a commit.
func voidSendKey(ctx context.Context, tx handle, groupID string) error {
	_, err := tx.ExecContext(ctx, `UPDATE group_infos SET send_key = NULL WHERE group_id = ?`, groupID)
	return err
}

// voidSendKeysOf forgets the send keys of every group someone is in, as one of their
// devices goes, or all of them do.
func voidSendKeysOf(ctx context.Context, tx handle, userID string) error {
	_, err := tx.ExecContext(ctx, `UPDATE group_infos SET send_key = NULL
		WHERE group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)`, userID)
	return err
}

// GroupInfo returns the latest published MLS GroupInfo, used for external joins.
func (d *DB) GroupInfo(ctx context.Context, groupID string) ([]byte, int64, error) {
	var info []byte
	var epoch int64
	err := d.sql.QueryRowContext(ctx, `SELECT i.info, g.epoch FROM groups g LEFT JOIN group_infos i ON i.group_id = g.id
		WHERE g.id = ?`, groupID).Scan(&info, &epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, ErrNotFound
	}
	return info, epoch, err
}
