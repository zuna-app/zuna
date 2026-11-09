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
	// DMUsers are the two people a direct message is between, who stay its two
	// once either has left the server.
	DMUsers []string `json:"dm_users,omitempty"`
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
	err := d.tx(ctx, func(tx handle) error {
		created = false
		err := tx.QueryRowContext(ctx, `SELECT id FROM groups WHERE dm_key = ?`, key).Scan(&id)
		if err == nil {
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		// A private bot isn't there for someone it shares no chat with.
		if seen, err := canSee(ctx, tx, creator, peer); err != nil {
			return err
		} else if !seen {
			return ErrNotFound
		}
		var banned sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(banned_at, deleted_at) FROM users WHERE id = ?`, peer).Scan(&banned); err != nil {
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
	err := d.tx(ctx, func(tx handle) error {
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
	g, err := scanGroup(d.sql.QueryRowContext(ctx, `SELECT `+groupColumns+` FROM groups g WHERE g.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	members, err := d.groupMembers(ctx, id)
	if err != nil {
		return nil, err
	}
	g.Members = members
	return g, nil
}

// GroupKind returns a group's kind, "dm", "group" or "channel", without loading its members.
func (d *DB) GroupKind(ctx context.Context, id string) (string, error) {
	var kind string
	err := d.sql.QueryRowContext(ctx, `SELECT kind FROM groups WHERE id = ?`, id).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return kind, err
}

const groupColumns = `g.id, g.kind, g.dm_key, g.epoch, g.seq, g.meta, g.meta_epoch, g.history_visible, g.created_by, g.created_at`

// scanGroup reads a group's row, as groupColumns lists it, without its members.
func scanGroup(row interface{ Scan(...any) error }) (*Group, error) {
	var g Group
	var metaEpoch sql.NullInt64
	var history int
	var dmKey sql.NullString
	if err := row.Scan(&g.ID, &g.Kind, &dmKey, &g.Epoch, &g.Seq, &g.Meta, &metaEpoch, &history, &g.CreatedBy, &g.CreatedAt); err != nil {
		return nil, err
	}
	g.MetaEpoch = nullableInt(metaEpoch)
	g.HistoryVisible = history != 0
	if dmKey.Valid {
		g.DMUsers = strings.Split(dmKey.String, ":")
	}
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

// UserGroupIDs returns the IDs of every group the user belongs to.
func (d *DB) UserGroupIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT group_id FROM group_members WHERE user_id = ?`, userID)
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

// UserGroups returns every group the user belongs to, with their members, in two queries
// however many groups that is, as every app asks for it each time it connects.
func (d *DB) UserGroups(ctx context.Context, userID string) ([]*Group, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT `+groupColumns+` FROM groups g JOIN group_members m ON m.group_id = g.id
		WHERE m.user_id = ? ORDER BY g.id`, userID)
	if err != nil {
		return nil, err
	}
	groups := []*Group{}
	byID := map[string]*Group{}
	for rows.Next() {
		group, err := scanGroup(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		group.Members = []GroupMember{}
		groups = append(groups, group)
		byID[group.ID] = group
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(groups) == 0 {
		return groups, err
	}
	rows, err = d.sql.QueryContext(ctx, `SELECT gm.group_id, gm.user_id, gm.role, gm.joined_at, gm.visible_from_seq, gm.read_state, gm.proof, gm.history_wanted
		FROM group_members gm WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)
		ORDER BY gm.group_id, gm.joined_at`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var groupID string
		var m GroupMember
		if err := rows.Scan(&groupID, &m.UserID, &m.Role, &m.JoinedAt, &m.VisibleFromSeq, &m.ReadState, &m.Proof, &m.HistoryWanted); err != nil {
			return nil, err
		}
		// A group this user joined between the two queries comes next time.
		if group := byID[groupID]; group != nil {
			group.Members = append(group.Members, m)
		}
	}
	return groups, rows.Err()
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

// RemoveMember takes a user out of the roster and logs it, so that a remaining
// member's client can commit the removal of their MLS leaves.
func (d *DB) RemoveMember(ctx context.Context, groupID, actor, target string) (*GroupEvent, error) {
	var event GroupEvent
	err := d.tx(ctx, func(tx handle) error {
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
	err := d.tx(ctx, func(tx handle) error {
		promoted = false
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
	err := d.tx(ctx, func(tx handle) error {
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
