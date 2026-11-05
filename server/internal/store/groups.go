package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
)

// Group is a conversation. The server knows who is in it and how its MLS epoch
// has advanced, but not its name, avatar or content.
type Group struct {
	ID             string        `json:"id"`
	Kind           string        `json:"kind"` // "dm", "group" or "channel"
	Epoch          int64         `json:"epoch"`
	Seq            int64         `json:"seq"`
	Meta           []byte        `json:"meta"`
	MetaEpoch      *int64        `json:"meta_epoch"`
	HistoryVisible bool          `json:"history_visible"`
	CreatedBy      string        `json:"created_by"`
	CreatedAt      int64         `json:"created_at"`
	Members        []GroupMember `json:"members"`
}

type GroupMember struct {
	UserID         string `json:"user_id"`
	Role           string `json:"role"`
	JoinedAt       int64  `json:"joined_at"`
	VisibleFromSeq int64  `json:"visible_from_seq"`
	ReadState      []byte `json:"read_state"`
	// In a channel: that they hold the community key, for other members to check.
	Proof []byte `json:"proof,omitempty"`
	// In a channel: they're waiting for a member to hand them its older keys.
	HistoryWanted bool `json:"history_wanted,omitempty"`
}

// GroupEvent is an entry in a group's ordered log: an MLS commit, or a roster
// change clients still have to reflect in the MLS tree.
type GroupEvent struct {
	GroupID      string `json:"group_id"`
	Seq          int64  `json:"seq"`
	Kind         string `json:"kind"` // "commit", "member_left" or "commit_voided"
	Epoch        int64  `json:"epoch"`
	Data         []byte `json:"data,omitempty"`
	SenderUser   string `json:"sender_user"`
	SenderDevice string `json:"sender_device,omitempty"`
	TargetUser   string `json:"target_user,omitempty"`
	CreatedAt    int64  `json:"created_at"`
}

// Commit describes a request to advance a group by one epoch.
type Commit struct {
	GroupID       string
	SenderUser    string
	SenderDevice  string
	ExpectedEpoch int64
	Data          []byte
	GroupInfo     []byte
	Kind          string
	AddUsers      []string
	RemoveUsers   []string
	Welcomes      []Welcome
	Meta          []byte
	MetaEpoch     *int64
	HistoryGrants []HistoryGrant
	// A group's admins from now on, as the roster in the commit names them, or nil
	// to leave them be. The server can't read the roster, so only an admin may say.
	Admins *[]string
	// What this person may have in commits, as CreateFile's quota is for files.
	Quota int64
}

type Welcome struct {
	ID       int64  `json:"id"`
	DeviceID string `json:"device_id"`
	GroupID  string `json:"group_id"`
	Data     []byte `json:"data"`
}

type HistoryGrant struct {
	ID      int64  `json:"id"`
	UserID  string `json:"user_id"`
	GroupID string `json:"group_id"`
	Data    []byte `json:"data"`
}

// DMKey is the unique key of the DM between two users. A user's DM with
// themselves acts as their saved messages.
func DMKey(a, b string) string {
	pair := []string{a, b}
	sort.Strings(pair)
	return strings.Join(pair, ":")
}

// GetOrCreateDM returns the DM between two users, creating it if needed.
func (d *DB) GetOrCreateDM(ctx context.Context, creator, peer string) (*Group, bool, error) {
	key := DMKey(creator, peer)
	var id string
	created := false
	err := d.tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRowContext(ctx, `SELECT id FROM groups WHERE dm_key = ?`, key).Scan(&id)
		if err == nil {
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		var banned sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT banned_at FROM users WHERE id = ?`, peer).Scan(&banned); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if banned.Valid {
			return ErrForbidden
		}
		now := Now()
		id = NewID()
		if _, err := tx.ExecContext(ctx, `INSERT INTO groups(id, kind, dm_key, created_by, created_at) VALUES(?, 'dm', ?, ?, ?)`,
			id, key, creator, now); err != nil {
			return err
		}
		for _, user := range uniqueStrings(creator, peer) {
			if _, err := tx.ExecContext(ctx, `INSERT INTO group_members(group_id, user_id, role, joined_at) VALUES(?, ?, 'admin', ?)`,
				id, user, now); err != nil {
				return err
			}
		}
		created = true
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	group, err := d.Group(ctx, id)
	return group, created, err
}

func uniqueStrings(values ...string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, v := range values {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}

// CreateGroup creates an invite-only group with the creator as its admin.
func (d *DB) CreateGroup(ctx context.Context, creator string, historyVisible bool) (*Group, error) {
	id := NewID()
	now := Now()
	err := d.tx(ctx, func(tx *sql.Tx) error {
		var created int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM groups WHERE created_by = ? AND kind = 'group'`, creator).Scan(&created); err != nil {
			return err
		}
		if created >= maxGroupsCreated {
			return ErrLimit
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO groups(id, kind, history_visible, created_by, created_at) VALUES(?, 'group', ?, ?, ?)`,
			id, historyVisible, creator, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO group_members(group_id, user_id, role, joined_at) VALUES(?, ?, 'admin', ?)`,
			id, creator, now)
		return err
	})
	if err != nil {
		return nil, err
	}
	return d.Group(ctx, id)
}

func (d *DB) Group(ctx context.Context, id string) (*Group, error) {
	var g Group
	var metaEpoch sql.NullInt64
	var history int
	err := d.sql.QueryRowContext(ctx, `SELECT id, kind, epoch, seq, meta, meta_epoch, history_visible, created_by, created_at
		FROM groups WHERE id = ?`, id).Scan(&g.ID, &g.Kind, &g.Epoch, &g.Seq, &g.Meta, &metaEpoch, &history, &g.CreatedBy, &g.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	g.MetaEpoch = nullableInt(metaEpoch)
	g.HistoryVisible = history != 0
	members, err := d.groupMembers(ctx, id)
	if err != nil {
		return nil, err
	}
	g.Members = members
	return &g, nil
}

func (d *DB) groupMembers(ctx context.Context, groupID string) ([]GroupMember, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT user_id, role, joined_at, visible_from_seq, read_state, proof, history_wanted
		FROM group_members WHERE group_id = ? ORDER BY joined_at`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []GroupMember{}
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.UserID, &m.Role, &m.JoinedAt, &m.VisibleFromSeq, &m.ReadState, &m.Proof, &m.HistoryWanted); err != nil {
			return nil, err
		}
		members = append(members, m)
	}
	return members, rows.Err()
}

// GroupMemberIDs returns the user IDs in a group.
func (d *DB) GroupMemberIDs(ctx context.Context, groupID string) ([]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT user_id FROM group_members WHERE group_id = ?`, groupID)
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

// UserGroups returns every group the user belongs to.
func (d *DB) UserGroups(ctx context.Context, userID string) ([]*Group, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT group_id FROM group_members WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	groups := make([]*Group, 0, len(ids))
	for _, id := range ids {
		group, err := d.Group(ctx, id)
		if err != nil {
			return nil, err
		}
		groups = append(groups, group)
	}
	return groups, nil
}

// Membership returns the user's role in the group, or ErrForbidden.
func (d *DB) Membership(ctx context.Context, groupID, userID string) (*GroupMember, error) {
	var m GroupMember
	err := d.sql.QueryRowContext(ctx, `SELECT user_id, role, joined_at, visible_from_seq, read_state
		FROM group_members WHERE group_id = ? AND user_id = ?`, groupID, userID).Scan(
		&m.UserID, &m.Role, &m.JoinedAt, &m.VisibleFromSeq, &m.ReadState)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrForbidden
	}
	return &m, err
}

func nextSeq(ctx context.Context, tx *sql.Tx, groupID string) (int64, error) {
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
	err := d.tx(ctx, func(tx *sql.Tx) error {
		var epoch int64
		var kind string
		var replaced []byte
		err := tx.QueryRowContext(ctx, `SELECT epoch, kind, group_info FROM groups WHERE id = ?`, c.GroupID).Scan(&epoch, &kind, &replaced)
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
		for _, user := range c.AddUsers {
			var banned sql.NullInt64
			if err := tx.QueryRowContext(ctx, `SELECT banned_at FROM users WHERE id = ?`, user).Scan(&banned); err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return ErrNotFound
				}
				return err
			}
			if banned.Valid {
				return ErrForbidden
			}
			// New members can only see messages sent after they joined, unless
			// an admin handed them the older epoch keys with a history grant.
			from := visibleFrom
			for _, grant := range c.HistoryGrants {
				if grant.UserID == user {
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
			if _, err := tx.ExecContext(ctx, `UPDATE groups SET epoch = ?, group_info = ?, meta = ?, meta_epoch = ? WHERE id = ?`,
				newEpoch, c.GroupInfo, c.Meta, c.MetaEpoch, c.GroupID); err != nil {
				return err
			}
		} else {
			if _, err := tx.ExecContext(ctx, `UPDATE groups SET epoch = ?, group_info = ? WHERE id = ?`,
				newEpoch, c.GroupInfo, c.GroupID); err != nil {
				return err
			}
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
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO group_events(group_id, seq, kind, epoch, data, sender_user, sender_device, created_at, replaced_info)
			VALUES(?,?,?,?,?,?,?,?,?)`, c.GroupID, seq, "commit", newEpoch, c.Data, c.SenderUser, c.SenderDevice, now, replaced)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE group_events SET replaced_info = NULL WHERE group_id = ? AND epoch <= ? AND replaced_info IS NOT NULL`,
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
func countCommit(ctx context.Context, tx *sql.Tx, c Commit) error {
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
func checkCommitExtras(ctx context.Context, tx *sql.Tx, c Commit, role string) error {
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
func (d *DB) VoidCommits(ctx context.Context, groupID, sender, senderDevice string, byAdmin bool, from, to int64, groupInfo []byte) (*GroupEvent, []string, error) {
	var event GroupEvent
	var senders []string
	err := d.tx(ctx, func(tx *sql.Tx) error {
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
			var held []byte
			err := tx.QueryRowContext(ctx, `SELECT replaced_info FROM group_events WHERE group_id = ? AND kind = 'commit' AND epoch = ?`,
				groupID, to+1).Scan(&held)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && len(held) == 0 && to != 0) {
				return ErrForbidden
			}
			if err != nil {
				return err
			}
			groupInfo = held
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM group_events WHERE group_id = ? AND kind = 'commit' AND epoch > ?`, groupID, to); err != nil {
			return err
		}
		// With nothing to go back to, the group starts again from nothing.
		var info any
		if len(groupInfo) > 0 {
			info = groupInfo
		}
		if _, err := tx.ExecContext(ctx, `UPDATE groups SET epoch = ?, group_info = ? WHERE id = ?`, to, info, groupID); err != nil {
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
func commitSenders(ctx context.Context, tx *sql.Tx, groupID string, after int64) ([]string, bool, error) {
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

// GroupInfo returns the latest published MLS GroupInfo, used for external joins.
func (d *DB) GroupInfo(ctx context.Context, groupID string) ([]byte, int64, error) {
	var info []byte
	var epoch int64
	err := d.sql.QueryRowContext(ctx, `SELECT group_info, epoch FROM groups WHERE id = ?`, groupID).Scan(&info, &epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, ErrNotFound
	}
	return info, epoch, err
}

// RemoveMember takes a user out of the roster and logs it, so that a remaining
// member's client can commit the removal of their MLS leaves.
func (d *DB) RemoveMember(ctx context.Context, groupID, actor, target string) (*GroupEvent, error) {
	var event GroupEvent
	err := d.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `DELETE FROM group_members WHERE group_id = ? AND user_id = ?`, groupID, target)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		var epoch int64
		if err := tx.QueryRowContext(ctx, `SELECT epoch FROM groups WHERE id = ?`, groupID).Scan(&epoch); err != nil {
			return err
		}
		seq, err := nextSeq(ctx, tx, groupID)
		if err != nil {
			return err
		}
		event = GroupEvent{
			GroupID: groupID, Seq: seq, Kind: "member_left", Epoch: epoch,
			SenderUser: actor, TargetUser: target, CreatedAt: Now(),
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO group_events(group_id, seq, kind, epoch, sender_user, target_user, created_at)
			VALUES(?,?,?,?,?,?,?)`, groupID, seq, "member_left", epoch, actor, target, event.CreatedAt)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &event, nil
}

// PromoteIfNoAdmin makes the longest-standing member an admin if none remain.
func (d *DB) PromoteIfNoAdmin(ctx context.Context, groupID string) (bool, error) {
	var promoted bool
	err := d.tx(ctx, func(tx *sql.Tx) error {
		// A channel's admins are the server's, however many of them are in it.
		var kind string
		if err := tx.QueryRowContext(ctx, `SELECT kind FROM groups WHERE id = ?`, groupID).Scan(&kind); err != nil {
			return err
		}
		if kind == "channel" {
			return nil
		}
		var admins int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_members WHERE group_id = ? AND role = 'admin'`, groupID).Scan(&admins); err != nil {
			return err
		}
		if admins > 0 {
			return nil
		}
		res, err := tx.ExecContext(ctx, `UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = (
			SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at LIMIT 1)`, groupID, groupID)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		promoted = n > 0
		return nil
	})
	return promoted, err
}

func (d *DB) SetGroupMeta(ctx context.Context, groupID string, meta []byte, epoch int64, historyVisible *bool) error {
	if historyVisible != nil {
		_, err := d.sql.ExecContext(ctx, `UPDATE groups SET meta = ?, meta_epoch = ?, history_visible = ? WHERE id = ?`,
			meta, epoch, *historyVisible, groupID)
		return err
	}
	_, err := d.sql.ExecContext(ctx, `UPDATE groups SET meta = ?, meta_epoch = ? WHERE id = ?`, meta, epoch, groupID)
	return err
}

func (d *DB) SetReadState(ctx context.Context, groupID, userID string, state []byte) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE group_members SET read_state = ? WHERE group_id = ? AND user_id = ?`, state, groupID, userID)
	return err
}

// DeleteGroup removes a group and everything in it, returning the files no
// other group uses.
func (d *DB) DeleteGroup(ctx context.Context, groupID string) ([]string, error) {
	var fileIDs []string
	err := d.tx(ctx, func(tx *sql.Tx) error {
		var err error
		fileIDs, err = collectStrings(ctx, tx, `SELECT DISTINCT file_id FROM file_refs WHERE group_id = ?`, groupID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM groups WHERE id = ?`, groupID); err != nil {
			return err
		}
		fileIDs, err = unreferenced(ctx, tx, fileIDs)
		return err
	})
	return fileIDs, err
}

// Welcomes returns pending Welcome messages for a device.
func (d *DB) Welcomes(ctx context.Context, deviceID string) ([]Welcome, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, device_id, group_id, data FROM welcomes WHERE device_id = ? ORDER BY id`, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	welcomes := []Welcome{}
	for rows.Next() {
		var w Welcome
		if err := rows.Scan(&w.ID, &w.DeviceID, &w.GroupID, &w.Data); err != nil {
			return nil, err
		}
		welcomes = append(welcomes, w)
	}
	return welcomes, rows.Err()
}

func (d *DB) DeleteWelcome(ctx context.Context, deviceID string, id int64) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM welcomes WHERE id = ? AND device_id = ?`, id, deviceID)
	return err
}

func (d *DB) HistoryGrants(ctx context.Context, userID string) ([]HistoryGrant, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, user_id, group_id, data FROM history_grants WHERE user_id = ? ORDER BY id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	grants := []HistoryGrant{}
	for rows.Next() {
		var g HistoryGrant
		if err := rows.Scan(&g.ID, &g.UserID, &g.GroupID, &g.Data); err != nil {
			return nil, err
		}
		grants = append(grants, g)
	}
	return grants, rows.Err()
}

func (d *DB) DeleteHistoryGrant(ctx context.Context, userID string, id int64) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM history_grants WHERE id = ? AND user_id = ?`, id, userID)
	return err
}
