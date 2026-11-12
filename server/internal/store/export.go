package store

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
)

// Export is everything this server keeps that's tied to one account, as it holds it, for
// the person whose account it is to see (POST /api/account/export).
//
// The account's own record and its devices' are given in full, but for what a copy would
// let someone guess the password from, or act with, which is only sized: the sign-in
// checks, the password's and recovery key's slots, the codes of invites and the handles
// phones are woken through. What's kept in bulk is counted and sized, not sent: messages,
// the vault, files, key packages, welcomes, and each conversation's encrypted details.
// Reports others made about the account are left out, so that nobody can tell from it
// when they were reported.
type Export struct {
	ExportedAt int64 `json:"exported_at"`
	Account    ExportAccount `json:"account"`
	SignIn     ExportSignIn  `json:"sign_in"`
	Devices    []ExportDevice `json:"devices"`
	// SigningIn is the sessions of sign-ins that haven't registered a device yet.
	SigningIn     []ExportSession      `json:"signing_in"`
	Conversations []ExportConversation `json:"conversations"`
	Vault         ExportVault          `json:"vault"`
	Files         []ExportFile         `json:"files"`
	Uploads       []ExportUpload       `json:"uploads"`
	Tokens        []ExportTokens       `json:"tokens"`
	Invites       []ExportInvite       `json:"invites"`
	Bots          []ExportBot          `json:"bots"`
	Admin         ExportAdmin          `json:"admin"`
	KeyChanges    ExportKeyChanges     `json:"key_changes"`
}

type ExportAccount struct {
	ID           string  `json:"id"`
	Username     string  `json:"username"`
	Role         string  `json:"role"`
	CreatedAt    int64   `json:"created_at"`
	UpdatedAt    int64   `json:"updated_at"`
	LastSeenAt   *int64  `json:"last_seen_at"`
	HideLastSeen bool    `json:"hide_last_seen"`
	BannedAt     *int64  `json:"banned_at"`
	BannedBy     *string `json:"banned_by"`
	DeletedAt    *int64  `json:"deleted_at"`
	// KeyGeneration is how many times the account's keys have been replaced.
	KeyGeneration int64  `json:"key_generation"`
	IdentityKey   []byte `json:"identity_key"`
	IdentityHead  []byte `json:"identity_head"`
	HpkeKey       []byte `json:"hpke_key"`
	HpkeKeySig    []byte `json:"hpke_key_sig"`
	// Profile is sealed with the community key, which the server doesn't hold.
	Profile    []byte  `json:"profile"`
	ProfileSig []byte  `json:"profile_sig"`
	AvatarFile *string `json:"avatar_file"`
	// VaultCore is the account's keys, sealed with its account key.
	VaultCore []byte `json:"vault_core"`
	// StoredBytes and CommitBytes are what the server counts against the account's quota.
	StoredBytes int64 `json:"stored_bytes"`
	CommitBytes int64 `json:"commit_bytes"`
}

type ExportSignIn struct {
	// KDF is what anyone is told who asks to sign in as the account.
	KDF              KDFParams           `json:"kdf"`
	AuthHashSize     int64               `json:"auth_hash_size"`
	RecoveryHashSize int64               `json:"recovery_hash_size"`
	Slots            []ExportSlot        `json:"slots"`
	Attempts         *ExportAttempts     `json:"attempts"`
}

type ExportSlot struct {
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

type ExportAttempts struct {
	Attempts int   `json:"attempts"`
	Until    int64 `json:"until"`
	SeenAt   int64 `json:"seen_at"`
}

type ExportDevice struct {
	ID             string          `json:"id"`
	CreatedAt      int64           `json:"created_at"`
	LastSeenAt     int64           `json:"last_seen_at"`
	RevokedAt      *int64          `json:"revoked_at"`
	SignatureKey   []byte          `json:"signature_key"`
	Certificate    []byte          `json:"certificate"`
	SealKey        []byte          `json:"seal_key"`
	SealGeneration *int64          `json:"seal_generation"`
	SealProof      []byte          `json:"seal_proof"`
	EnrollProof    []byte          `json:"enroll_proof"`
	Sessions       []ExportSession `json:"sessions"`
	KeyPackages    ExportBulk      `json:"key_packages"`
	Welcomes       ExportBulk      `json:"welcomes"`
	// AccountKey is the account key sealed to the device, for the generation it's from.
	AccountKey *ExportSealed `json:"account_key"`
	Push       *ExportPush   `json:"push"`
}

type ExportSession struct {
	CreatedAt  int64 `json:"created_at"`
	LastUsedAt int64 `json:"last_used_at"`
}

// ExportBulk is how many of something are kept, and their size in bytes.
type ExportBulk struct {
	Count int64 `json:"count"`
	Bytes int64 `json:"bytes"`
}

type ExportSealed struct {
	Generation int64 `json:"generation"`
	Size       int64 `json:"size"`
}

type ExportPush struct {
	Relay          string            `json:"relay"`
	HandleSize     int64             `json:"handle_size"`
	CallHandleSize int64             `json:"call_handle_size"`
	Key            []byte            `json:"key"`
	Registration   string            `json:"registration"`
	Muted          map[string]int64  `json:"muted"`
	Filters        bool              `json:"filters"`
	Notified       []string          `json:"notified"`
	UpdatedAt      int64             `json:"updated_at"`
}

type ExportConversation struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// DMKey is the two accounts a direct message is between, which the server finds it by.
	DMKey          string `json:"dm_key,omitempty"`
	CreatedBy      string `json:"created_by"`
	CreatedAt      int64  `json:"created_at"`
	Epoch          int64  `json:"epoch"`
	Changes        int64  `json:"changes"`
	HistoryVisible bool   `json:"history_visible"`
	// MetaSize is the size of its name, picture and description, sealed for its members.
	MetaSize int64 `json:"meta_size"`
	// Membership is nil for a conversation the account has left that the server still
	// has a trace of it in.
	Membership  *ExportMembership `json:"membership"`
	MemberCount int64             `json:"member_count"`
	// Members is who's in a direct message or a group. A channel's are only counted, as
	// they're whoever on the server joined it.
	Members  []ExportMember `json:"members"`
	Messages ExportMessages `json:"messages"`
	// ByYou and ToYou are the changes to who's in it, and to its keys, that the account
	// made, and that were about it, still kept.
	ByYou ExportEvents `json:"by_you"`
	ToYou ExportEvents `json:"to_you"`
}

type ExportMembership struct {
	Role           string `json:"role"`
	JoinedAt       int64  `json:"joined_at"`
	VisibleFromSeq int64  `json:"visible_from_seq"`
	ReadStateSize  int64  `json:"read_state_size"`
	ProofSize      int64  `json:"proof_size"`
	HistoryWanted  bool   `json:"history_wanted"`
}

type ExportMember struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	JoinedAt int64  `json:"joined_at"`
}

type ExportMessages struct {
	Count   int64  `json:"count"`
	Bytes   int64  `json:"bytes"`
	Deleted int64  `json:"deleted"`
	First   *int64 `json:"first"`
	Last    *int64 `json:"last"`
}

type ExportEvents struct {
	Count int64  `json:"count"`
	Last  *int64 `json:"last"`
}

type ExportVault struct {
	Items         ExportBulk `json:"items"`
	HistoryGrants ExportBulk `json:"history_grants"`
}

type ExportFile struct {
	ID          string `json:"id"`
	Size        int64  `json:"size"`
	CreatedAt   int64  `json:"created_at"`
	CompletedAt *int64 `json:"completed_at"`
	AttachedAt  *int64 `json:"attached_at"`
	// Standalone is a picture no message carries: a profile's or a group's.
	Standalone bool `json:"standalone"`
}

type ExportUpload struct {
	// Day is when the day began, in Unix milliseconds.
	Day int64 `json:"day"`
	MiB int64 `json:"mib"`
}

type ExportTokens struct {
	// Period is when the six hours began, in Unix milliseconds.
	Period int64  `json:"period"`
	Size   string `json:"size"`
	Issued int64  `json:"issued"`
}

type ExportInvite struct {
	CreatedAt  int64  `json:"created_at"`
	GrantsRole string `json:"grants_role"`
	MaxUses    int64  `json:"max_uses"`
	Uses       int64  `json:"uses"`
	ExpiresAt  *int64 `json:"expires_at"`
	RevokedAt  *int64 `json:"revoked_at"`
}

type ExportBot struct {
	ID        string   `json:"id"`
	Username  string   `json:"username"`
	Listed    bool     `json:"listed"`
	AddPolicy string   `json:"add_policy"`
	Files     bool     `json:"files"`
	CreatedAt int64    `json:"created_at"`
	SetUpAt   *int64   `json:"set_up_at"`
	DeletedAt *int64   `json:"deleted_at"`
	Channels  []string `json:"channels"`
}

type ExportAdmin struct {
	Channels []ExportMade   `json:"channels"`
	Sounds   []ExportMade   `json:"sounds"`
	Banned   []ExportBanned `json:"banned"`
}

type ExportMade struct {
	ID        string `json:"id"`
	CreatedAt int64  `json:"created_at"`
}

type ExportBanned struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	BannedAt int64  `json:"banned_at"`
}

type ExportKeyChanges struct {
	// Links are the account's replacements of its keys, each signed by the keys before.
	Links []ExportLink `json:"links"`
	// LogEntries is how many entries about the account the log of keys has.
	LogEntries int64 `json:"log_entries"`
}

type ExportLink struct {
	Generation int64 `json:"generation"`
	CreatedAt  int64 `json:"created_at"`
}

// Export reads everything kept about one account, in one read-only snapshot.
func (d *DB) Export(ctx context.Context, userID string) (*Export, error) {
	options := &sql.TxOptions{ReadOnly: true}
	if d.postgres {
		options.Isolation = sql.LevelRepeatableRead
	}
	snapshot, err := d.conn.BeginTx(d.sql.context(ctx, "BEGIN"), options)
	if err != nil {
		return nil, err
	}
	defer snapshot.Rollback()
	r := exportReader{ctx: ctx, q: handle{q: snapshot, postgres: d.postgres, hooks: d.hooks}, user: userID}
	out := &Export{ExportedAt: Now()}
	for _, step := range []func(*Export) error{r.account, r.signIn, r.devices, r.conversations, r.vault, r.files, r.tokens, r.invites, r.bots, r.admin, r.keyChanges} {
		if err := step(out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

type exportReader struct {
	ctx  context.Context
	q    handle
	user string
}

// each runs a query and scans each row it gives.
func (r exportReader) each(query string, args []any, scan func(*sql.Rows) error) error {
	rows, err := r.q.QueryContext(r.ctx, query, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (r exportReader) account(out *Export) error {
	a := &out.Account
	var lastSeen, banned, deleted sql.NullInt64
	var bannedBy, avatar sql.NullString
	var hide int64
	err := r.q.QueryRowContext(r.ctx, `SELECT id, username, role, created_at, updated_at, last_seen_at, hide_last_seen, banned_at, banned_by,
		deleted_at, key_generation, identity_key, identity_head, hpke_key, hpke_key_sig, profile, profile_sig, avatar_file, vault_core,
		stored_bytes, commit_bytes FROM users WHERE id = ?`, r.user).Scan(&a.ID, &a.Username, &a.Role, &a.CreatedAt, &a.UpdatedAt, &lastSeen, &hide,
		&banned, &bannedBy, &deleted, &a.KeyGeneration, &a.IdentityKey, &a.IdentityHead, &a.HpkeKey, &a.HpkeKeySig, &a.Profile, &a.ProfileSig,
		&avatar, &a.VaultCore, &a.StoredBytes, &a.CommitBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	a.LastSeenAt, a.BannedAt, a.DeletedAt = nullableInt(lastSeen), nullableInt(banned), nullableInt(deleted)
	a.HideLastSeen = hide != 0
	if bannedBy.Valid {
		a.BannedBy = &bannedBy.String
	}
	if avatar.Valid {
		a.AvatarFile = &avatar.String
	}
	return nil
}

func (r exportReader) signIn(out *Export) error {
	s := &out.SignIn
	if err := r.q.QueryRowContext(r.ctx, `SELECT kdf_salt, kdf_memory, kdf_iterations, kdf_parallelism, LENGTH(auth_hash), LENGTH(recovery_hash)
		FROM users WHERE id = ?`, r.user).Scan(&s.KDF.Salt, &s.KDF.Memory, &s.KDF.Iterations, &s.KDF.Parallelism, &s.AuthHashSize, &s.RecoveryHashSize); err != nil {
		return err
	}
	s.Slots = []ExportSlot{}
	if err := r.each(`SELECT kind, LENGTH(seal_key) + LENGTH(sign_key) + LENGTH(sealed_secret) + LENGTH(sealed_key) FROM account_slots
		WHERE user_id = ? ORDER BY kind`, []any{r.user}, func(rows *sql.Rows) error {
		var slot ExportSlot
		if err := rows.Scan(&slot.Kind, &slot.Size); err != nil {
			return err
		}
		s.Slots = append(s.Slots, slot)
		return nil
	}); err != nil {
		return err
	}
	var attempts ExportAttempts
	err := r.q.QueryRowContext(r.ctx, `SELECT attempts, until_at, seen_at FROM sign_in_attempts WHERE account = ?`,
		strings.ToLower(out.Account.Username)).Scan(&attempts.Attempts, &attempts.Until, &attempts.SeenAt)
	if err == nil {
		s.Attempts = &attempts
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

func (r exportReader) devices(out *Export) error {
	out.Devices = []ExportDevice{}
	index := map[string]*ExportDevice{}
	if err := r.each(`SELECT id, created_at, last_seen_at, revoked_at, signature_key, certificate, seal_key, seal_generation, seal_proof, enroll_proof
		FROM devices WHERE user_id = ? ORDER BY created_at, id`, []any{r.user}, func(rows *sql.Rows) error {
		var d ExportDevice
		var revoked, generation sql.NullInt64
		if err := rows.Scan(&d.ID, &d.CreatedAt, &d.LastSeenAt, &revoked, &d.SignatureKey, &d.Certificate, &d.SealKey, &generation, &d.SealProof, &d.EnrollProof); err != nil {
			return err
		}
		d.RevokedAt, d.SealGeneration = nullableInt(revoked), nullableInt(generation)
		d.Sessions = []ExportSession{}
		out.Devices = append(out.Devices, d)
		return nil
	}); err != nil {
		return err
	}
	for i := range out.Devices {
		index[out.Devices[i].ID] = &out.Devices[i]
	}
	out.SigningIn = []ExportSession{}
	if err := r.each(`SELECT device_id, created_at, last_used_at FROM sessions WHERE user_id = ? ORDER BY created_at`, []any{r.user}, func(rows *sql.Rows) error {
		var device sql.NullString
		var s ExportSession
		if err := rows.Scan(&device, &s.CreatedAt, &s.LastUsedAt); err != nil {
			return err
		}
		if d, ok := index[device.String]; ok && device.Valid {
			d.Sessions = append(d.Sessions, s)
		} else {
			out.SigningIn = append(out.SigningIn, s)
		}
		return nil
	}); err != nil {
		return err
	}
	bulk := func(query string, set func(*ExportDevice, ExportBulk)) error {
		return r.each(query, []any{r.user}, func(rows *sql.Rows) error {
			var id string
			var b ExportBulk
			if err := rows.Scan(&id, &b.Count, &b.Bytes); err != nil {
				return err
			}
			if d, ok := index[id]; ok {
				set(d, b)
			}
			return nil
		})
	}
	if err := bulk(`SELECT k.device_id, COUNT(*), COALESCE(SUM(LENGTH(k.data)), 0) FROM key_packages k JOIN devices d ON d.id = k.device_id
		WHERE d.user_id = ? GROUP BY k.device_id`, func(d *ExportDevice, b ExportBulk) { d.KeyPackages = b }); err != nil {
		return err
	}
	if err := bulk(`SELECT w.device_id, COUNT(*), COALESCE(SUM(LENGTH(w.data)), 0) FROM welcomes w JOIN devices d ON d.id = w.device_id
		WHERE d.user_id = ? GROUP BY w.device_id`, func(d *ExportDevice, b ExportBulk) { d.Welcomes = b }); err != nil {
		return err
	}
	if err := r.each(`SELECT device_id, generation, LENGTH(data) FROM account_bundles WHERE user_id = ?`, []any{r.user}, func(rows *sql.Rows) error {
		var id string
		var sealed ExportSealed
		if err := rows.Scan(&id, &sealed.Generation, &sealed.Size); err != nil {
			return err
		}
		if d, ok := index[id]; ok {
			d.AccountKey = &sealed
		}
		return nil
	}); err != nil {
		return err
	}
	return r.each(`SELECT device_id, relay, LENGTH(handle), LENGTH(call_handle), push_key, registration, muted, filters, notified, updated_at
		FROM push_registrations WHERE user_id = ?`, []any{r.user}, func(rows *sql.Rows) error {
		var id, muted, notified string
		var filters int64
		var p ExportPush
		if err := rows.Scan(&id, &p.Relay, &p.HandleSize, &p.CallHandleSize, &p.Key, &p.Registration, &muted, &filters, &notified, &p.UpdatedAt); err != nil {
			return err
		}
		p.Muted, p.Filters, p.Notified = decodeMuted(muted), filters != 0, splitList(notified)
		if d, ok := index[id]; ok {
			d.Push = &p
		}
		return nil
	})
}

// splitList reads a comma-separated list, of which an empty string has nothing.
func splitList(value string) []string {
	out := []string{}
	for _, item := range strings.Split(value, ",") {
		if item != "" {
			out = append(out, item)
		}
	}
	return out
}

// conversations lists every conversation the account is in, every direct message it's
// one of the two of, and every one it has left where a change by it or about it is
// still kept.
func (r exportReader) conversations(out *Export) error {
	out.Conversations = []ExportConversation{}
	ids := map[string]bool{}
	collect := func(query string, args ...any) error {
		return r.each(query, args, func(rows *sql.Rows) error {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			ids[id] = true
			return nil
		})
	}
	if err := collect(`SELECT group_id FROM group_members WHERE user_id = ?`, r.user); err != nil {
		return err
	}
	if err := collect(`SELECT id FROM groups WHERE dm_key LIKE ? OR dm_key LIKE ?`, r.user+":%", "%:"+r.user); err != nil {
		return err
	}
	// One pass over the changes kept, which nothing indexes by who made them.
	byYou, toYou := map[string]ExportEvents{}, map[string]ExportEvents{}
	if err := r.each(`SELECT group_id, SUM(CASE WHEN sender_user = ? THEN 1 ELSE 0 END), MAX(CASE WHEN sender_user = ? THEN created_at END),
		SUM(CASE WHEN target_user = ? THEN 1 ELSE 0 END), MAX(CASE WHEN target_user = ? THEN created_at END)
		FROM group_events WHERE sender_user = ? OR target_user = ? GROUP BY group_id`, []any{r.user, r.user, r.user, r.user, r.user, r.user}, func(rows *sql.Rows) error {
		var id string
		var by, to ExportEvents
		var byLast, toLast sql.NullInt64
		if err := rows.Scan(&id, &by.Count, &byLast, &to.Count, &toLast); err != nil {
			return err
		}
		by.Last, to.Last = nullableInt(byLast), nullableInt(toLast)
		byYou[id], toYou[id], ids[id] = by, to, true
		return nil
	}); err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	list := make([]any, 0, len(ids))
	for id := range ids {
		list = append(list, id)
	}
	in := "(" + placeholders(len(list)) + ")"
	index := map[string]*ExportConversation{}
	if err := r.each(`SELECT id, kind, dm_key, created_by, created_at, epoch, seq, history_visible, COALESCE(LENGTH(meta), 0)
		FROM groups WHERE id IN `+in, list, func(rows *sql.Rows) error {
		var c ExportConversation
		var dmKey sql.NullString
		var history int64
		if err := rows.Scan(&c.ID, &c.Kind, &dmKey, &c.CreatedBy, &c.CreatedAt, &c.Epoch, &c.Changes, &history, &c.MetaSize); err != nil {
			return err
		}
		c.DMKey, c.HistoryVisible, c.Members = dmKey.String, history != 0, []ExportMember{}
		out.Conversations = append(out.Conversations, c)
		return nil
	}); err != nil {
		return err
	}
	sort.Slice(out.Conversations, func(i, j int) bool {
		a, b := out.Conversations[i], out.Conversations[j]
		return a.CreatedAt < b.CreatedAt || (a.CreatedAt == b.CreatedAt && a.ID < b.ID)
	})
	for i := range out.Conversations {
		index[out.Conversations[i].ID] = &out.Conversations[i]
	}
	if err := r.each(`SELECT group_id, role, joined_at, visible_from_seq, COALESCE(LENGTH(read_state), 0), COALESCE(LENGTH(proof), 0), history_wanted
		FROM group_members WHERE user_id = ?`, []any{r.user}, func(rows *sql.Rows) error {
		var id string
		var m ExportMembership
		var wanted int64
		if err := rows.Scan(&id, &m.Role, &m.JoinedAt, &m.VisibleFromSeq, &m.ReadStateSize, &m.ProofSize, &wanted); err != nil {
			return err
		}
		m.HistoryWanted = wanted != 0
		if c, ok := index[id]; ok {
			c.Membership = &m
		}
		return nil
	}); err != nil {
		return err
	}
	if err := r.each(`SELECT group_id, COUNT(*) FROM group_members WHERE group_id IN `+in+` GROUP BY group_id`, list, func(rows *sql.Rows) error {
		var id string
		var n int64
		if err := rows.Scan(&id, &n); err != nil {
			return err
		}
		if c, ok := index[id]; ok {
			c.MemberCount = n
		}
		return nil
	}); err != nil {
		return err
	}
	if err := r.each(`SELECT m.group_id, m.user_id, u.username, m.role, m.joined_at FROM group_members m JOIN users u ON u.id = m.user_id
		JOIN groups g ON g.id = m.group_id WHERE g.kind <> 'channel' AND m.group_id IN `+in+` ORDER BY m.joined_at, m.user_id`, list, func(rows *sql.Rows) error {
		var id string
		var m ExportMember
		if err := rows.Scan(&id, &m.ID, &m.Username, &m.Role, &m.JoinedAt); err != nil {
			return err
		}
		if c, ok := index[id]; ok {
			c.Members = append(c.Members, m)
		}
		return nil
	}); err != nil {
		return err
	}
	if err := r.each(`SELECT group_id, COUNT(*), COALESCE(SUM(LENGTH(envelope)), 0), COUNT(deleted_at), MIN(created_at), MAX(created_at)
		FROM messages WHERE group_id IN `+in+` GROUP BY group_id`, list, func(rows *sql.Rows) error {
		var id string
		var m ExportMessages
		var first, last sql.NullInt64
		if err := rows.Scan(&id, &m.Count, &m.Bytes, &m.Deleted, &first, &last); err != nil {
			return err
		}
		m.First, m.Last = nullableInt(first), nullableInt(last)
		if c, ok := index[id]; ok {
			c.Messages = m
		}
		return nil
	}); err != nil {
		return err
	}
	for id, c := range index {
		c.ByYou, c.ToYou = byYou[id], toYou[id]
	}
	return nil
}

func (r exportReader) vault(out *Export) error {
	if err := r.q.QueryRowContext(r.ctx, `SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM vault_items WHERE user_id = ?`, r.user).
		Scan(&out.Vault.Items.Count, &out.Vault.Items.Bytes); err != nil {
		return err
	}
	return r.q.QueryRowContext(r.ctx, `SELECT COUNT(*), COALESCE(SUM(LENGTH(data)), 0) FROM history_grants WHERE user_id = ?`, r.user).
		Scan(&out.Vault.HistoryGrants.Count, &out.Vault.HistoryGrants.Bytes)
}

func (r exportReader) files(out *Export) error {
	out.Files = []ExportFile{}
	if err := r.each(`SELECT id, total_size, created_at, completed_at, attached_at, standalone FROM files WHERE owner_id = ? ORDER BY created_at, id`,
		[]any{r.user}, func(rows *sql.Rows) error {
			var f ExportFile
			var completed, attached sql.NullInt64
			var standalone int64
			if err := rows.Scan(&f.ID, &f.Size, &f.CreatedAt, &completed, &attached, &standalone); err != nil {
				return err
			}
			f.CompletedAt, f.AttachedAt, f.Standalone = nullableInt(completed), nullableInt(attached), standalone != 0
			out.Files = append(out.Files, f)
			return nil
		}); err != nil {
		return err
	}
	out.Uploads = []ExportUpload{}
	return r.each(`SELECT day, mib FROM uploads WHERE user_id = ? ORDER BY day`, []any{r.user}, func(rows *sql.Rows) error {
		var u ExportUpload
		if err := rows.Scan(&u.Day, &u.MiB); err != nil {
			return err
		}
		u.Day *= dayMillis
		out.Uploads = append(out.Uploads, u)
		return nil
	})
}

func (r exportReader) tokens(out *Export) error {
	out.Tokens = []ExportTokens{}
	return r.each(`SELECT period, size, issued FROM token_issues WHERE user_id = ? ORDER BY period, size`, []any{r.user}, func(rows *sql.Rows) error {
		var t ExportTokens
		if err := rows.Scan(&t.Period, &t.Size, &t.Issued); err != nil {
			return err
		}
		t.Period *= TokenPeriod.Milliseconds()
		out.Tokens = append(out.Tokens, t)
		return nil
	})
}

func (r exportReader) invites(out *Export) error {
	out.Invites = []ExportInvite{}
	return r.each(`SELECT created_at, grants_role, max_uses, uses, expires_at, revoked_at FROM invites WHERE created_by = ? ORDER BY created_at`,
		[]any{r.user}, func(rows *sql.Rows) error {
			var i ExportInvite
			var expires, revoked sql.NullInt64
			if err := rows.Scan(&i.CreatedAt, &i.GrantsRole, &i.MaxUses, &i.Uses, &expires, &revoked); err != nil {
				return err
			}
			i.ExpiresAt, i.RevokedAt = nullableInt(expires), nullableInt(revoked)
			out.Invites = append(out.Invites, i)
			return nil
		})
}

func (r exportReader) bots(out *Export) error {
	out.Bots = []ExportBot{}
	if err := r.each(`SELECT id, username, listed, add_policy, files, created_at, set_up_at, deleted_at FROM bots WHERE owner_id = ? ORDER BY created_at, id`,
		[]any{r.user}, func(rows *sql.Rows) error {
			var b ExportBot
			var listed, files int64
			var setUp, deleted sql.NullInt64
			if err := rows.Scan(&b.ID, &b.Username, &listed, &b.AddPolicy, &files, &b.CreatedAt, &setUp, &deleted); err != nil {
				return err
			}
			b.Listed, b.Files, b.SetUpAt, b.DeletedAt, b.Channels = listed != 0, files != 0, nullableInt(setUp), nullableInt(deleted), []string{}
			out.Bots = append(out.Bots, b)
			return nil
		}); err != nil {
		return err
	}
	if len(out.Bots) == 0 {
		return nil
	}
	index := map[string]*ExportBot{}
	for i := range out.Bots {
		index[out.Bots[i].ID] = &out.Bots[i]
	}
	return r.each(`SELECT c.bot_id, c.channel_id FROM bot_channels c JOIN bots b ON b.id = c.bot_id WHERE b.owner_id = ? ORDER BY c.channel_id`,
		[]any{r.user}, func(rows *sql.Rows) error {
			var bot, channel string
			if err := rows.Scan(&bot, &channel); err != nil {
				return err
			}
			if b, ok := index[bot]; ok {
				b.Channels = append(b.Channels, channel)
			}
			return nil
		})
}

func (r exportReader) admin(out *Export) error {
	made := func(query string) ([]ExportMade, error) {
		list := []ExportMade{}
		err := r.each(query, []any{r.user}, func(rows *sql.Rows) error {
			var m ExportMade
			if err := rows.Scan(&m.ID, &m.CreatedAt); err != nil {
				return err
			}
			list = append(list, m)
			return nil
		})
		return list, err
	}
	var err error
	if out.Admin.Channels, err = made(`SELECT id, created_at FROM channels WHERE created_by = ? ORDER BY created_at, id`); err != nil {
		return err
	}
	if out.Admin.Sounds, err = made(`SELECT id, created_at FROM sounds WHERE created_by = ? ORDER BY created_at, id`); err != nil {
		return err
	}
	out.Admin.Banned = []ExportBanned{}
	return r.each(`SELECT id, username, banned_at FROM users WHERE banned_by = ? AND banned_at IS NOT NULL ORDER BY banned_at, id`, []any{r.user}, func(rows *sql.Rows) error {
		var b ExportBanned
		if err := rows.Scan(&b.ID, &b.Username, &b.BannedAt); err != nil {
			return err
		}
		out.Admin.Banned = append(out.Admin.Banned, b)
		return nil
	})
}

func (r exportReader) keyChanges(out *Export) error {
	out.KeyChanges.Links = []ExportLink{}
	if err := r.each(`SELECT generation, created_at FROM identity_links WHERE user_id = ? ORDER BY generation`, []any{r.user}, func(rows *sql.Rows) error {
		var link ExportLink
		if err := rows.Scan(&link.Generation, &link.CreatedAt); err != nil {
			return err
		}
		out.KeyChanges.Links = append(out.KeyChanges.Links, link)
		return nil
	}); err != nil {
		return err
	}
	return r.q.QueryRowContext(r.ctx, `SELECT COUNT(*) FROM log_entries WHERE user_id = ?`, r.user).Scan(&out.KeyChanges.LogEntries)
}
