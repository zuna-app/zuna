package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// PublicUser is what every member of a server can see about a user.
type PublicUser struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
	// IdentityKey is the root of the account's identity chain, the key every client
	// pins. KeyGeneration and IdentityHead say how far that chain has got, and
	// ProfileSig signs the profile with the head's key.
	IdentityKey   []byte   `json:"identity_key"`
	KeyGeneration int64    `json:"key_generation"`
	IdentityHead  []byte   `json:"identity_head"`
	HpkeKey       []byte   `json:"hpke_key"`
	HpkeKeySig    []byte   `json:"hpke_key_sig"`
	Profile       []byte   `json:"profile"`
	ProfileSig    []byte   `json:"profile_sig"`
	LastSeenAt    *int64   `json:"last_seen_at"`
	HideLastSeen  bool     `json:"hide_last_seen"`
	Banned        bool     `json:"banned"`
	Deleted       bool     `json:"deleted"`
	CreatedAt     int64    `json:"created_at"`
	UpdatedAt     int64    `json:"updated_at"`
	Devices       []Device `json:"devices"`
	// Bot is set for an account a program runs: whose it is, and who may see and add it.
	Bot *BotInfo `json:"bot,omitempty"`
}

// Device is one app install belonging to a user. The certificate is signed by
// the user's identity key, so the server can't invent a device.
type Device struct {
	ID           string `json:"id"`
	UserID       string `json:"user_id"`
	Certificate  []byte `json:"certificate"`
	SignatureKey []byte `json:"signature_key"`
	CreatedAt    int64  `json:"created_at"`
	LastSeenAt   int64  `json:"last_seen_at"`
	// RevokedAt is set once a device is removed. Revoked devices stay listed so
	// that messages they sent earlier can still be verified.
	RevokedAt *int64 `json:"revoked_at"`
	// SealKey is what to seal account keys to for this device. EnrollProof shows
	// that whoever made the device opened a password's or recovery key's slot.
	SealKey     []byte `json:"seal_key"`
	EnrollProof []byte `json:"enroll_proof"`
	// SealGeneration is the generation SealKey is from, and SealProof the device's
	// signature on the two together.
	SealGeneration *int64 `json:"seal_generation"`
	SealProof      []byte `json:"seal_proof"`
}

// KDFParams are the Argon2id settings a client must use to derive its keys.
type KDFParams struct {
	Salt        []byte `json:"salt"`
	Memory      int    `json:"memory"`
	Iterations  int    `json:"iterations"`
	Parallelism int    `json:"parallelism"`
}

// NewUser holds everything created on the client during sign-up.
type NewUser struct {
	Username     string
	KDF          KDFParams
	AuthHash     []byte
	AuthSalt     []byte
	RecoveryHash []byte
	RecoverySalt []byte
	IdentityKey  []byte
	HpkeKey      []byte
	HpkeKeySig   []byte
	VaultCore    []byte
	Profile      []byte
	Slots        []Slot
	// What the vault starts with, such as the manifest of what the account trusts,
	// so that a new device never finds an account without one.
	VaultItems []VaultItem
	// A bot's signature on its identity key, by the key its setup link held.
	BotProof []byte
}

// Credentials is the authentication material for one user.
type Credentials struct {
	UserID        string
	Username      string
	Role          string
	KDF           KDFParams
	AuthHash      []byte
	AuthSalt      []byte
	RecoveryHash  []byte
	RecoverySalt  []byte
	VaultCore     []byte
	Banned        bool
	KeyGeneration int64
}

// CreateUser consumes the invite (if any) and creates the user atomically.
// An empty inviteCode is only valid when open sign-ups are on. An invite that
// grants a bot makes the account of the bot waiting for it, under that bot's ID
// and the username it was made with.
func (d *DB) CreateUser(ctx context.Context, u NewUser, inviteCode string) (string, error) {
	fresh := NewID()
	id := fresh
	now := Now()
	err := d.tx(ctx, func(tx handle) error {
		id = fresh
		bot := ""
		role := "member"
		if inviteCode != "" {
			var grants string
			var maxUses, uses int
			var expires, revoked sql.NullInt64
			err := tx.QueryRowContext(ctx,
				`SELECT grants_role, max_uses, uses, expires_at, revoked_at FROM invites WHERE code = ?`,
				inviteCode).Scan(&grants, &maxUses, &uses, &expires, &revoked)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			if revoked.Valid || (expires.Valid && expires.Int64 < now) || (maxUses > 0 && uses >= maxUses) {
				return ErrNotFound
			}
			role = grants
			if _, err := tx.ExecContext(ctx, `UPDATE invites SET uses = uses + 1 WHERE code = ?`, inviteCode); err != nil {
				return err
			}
			if grants == "bot" {
				var reserved string
				err := tx.QueryRowContext(ctx, `SELECT id, username_key FROM bots WHERE invite_code = ? AND set_up_at IS NULL AND deleted_at IS NULL`,
					inviteCode).Scan(&bot, &reserved)
				if errors.Is(err, sql.ErrNoRows) || (err == nil && reserved != strings.ToLower(u.Username)) {
					return ErrNotFound
				}
				if err != nil {
					return err
				}
				// A bot is never one of the server's admins.
				id, role = bot, "member"
			}
		}
		// A waiting bot holds its username until it signs up with it.
		if taken, err := usernameTaken(ctx, tx, strings.ToLower(u.Username), bot); err != nil {
			return err
		} else if taken {
			return ErrConflict
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO users(
			id, username, username_key, role, kdf_salt, kdf_memory, kdf_iterations, kdf_parallelism,
			auth_hash, auth_salt, recovery_hash, recovery_salt,
			identity_key, hpke_key, hpke_key_sig, vault_core, profile, created_at, updated_at
		) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			id, u.Username, strings.ToLower(u.Username), role,
			u.KDF.Salt, u.KDF.Memory, u.KDF.Iterations, u.KDF.Parallelism,
			u.AuthHash, u.AuthSalt, u.RecoveryHash, u.RecoverySalt,
			u.IdentityKey, u.HpkeKey, u.HpkeKeySig, u.VaultCore, u.Profile, now, now)
		if isUniqueViolation(err) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		if err := d.insertSlots(ctx, tx, id, u.Slots); err != nil {
			return err
		}
		if bot != "" {
			if _, err := tx.ExecContext(ctx, `UPDATE bots SET set_up_at = ?, invite_code = NULL, setup_proof = ? WHERE id = ?`, now, u.BotProof, bot); err != nil {
				return err
			}
		}
		return putItems(ctx, tx, id, u.VaultItems)
	})
	return id, err
}

func (d *DB) CredentialsByUsername(ctx context.Context, username string) (*Credentials, error) {
	var c Credentials
	var banned sql.NullInt64
	err := d.sql.QueryRowContext(ctx, `SELECT id, username, role, kdf_salt, kdf_memory, kdf_iterations, kdf_parallelism,
		auth_hash, auth_salt, recovery_hash, recovery_salt, vault_core, banned_at, key_generation
		FROM users WHERE username_key = ?`, strings.ToLower(username)).Scan(
		&c.UserID, &c.Username, &c.Role, &c.KDF.Salt, &c.KDF.Memory, &c.KDF.Iterations, &c.KDF.Parallelism,
		&c.AuthHash, &c.AuthSalt, &c.RecoveryHash, &c.RecoverySalt,
		&c.VaultCore, &banned, &c.KeyGeneration)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	c.Banned = banned.Valid
	return &c, err
}

// publicUserColumns are read from publicUsers: an account, and its bot's row if it's one.
const publicUserColumns = `u.id, u.username, u.role, u.identity_key, u.key_generation, u.identity_head, u.hpke_key, u.hpke_key_sig, u.profile, u.profile_sig,
	u.last_seen_at, u.hide_last_seen, u.banned_at, u.deleted_at, u.created_at, u.updated_at, b.owner_id, b.listed, b.add_policy, b.setup_proof`

const publicUsers = `users u LEFT JOIN bots b ON b.id = u.id`

const deviceColumns = `id, user_id, certificate, signature_key, created_at, last_seen_at, revoked_at, seal_key, enroll_proof, seal_generation, seal_proof`

func scanDevice(row interface{ Scan(...any) error }) (Device, error) {
	var dev Device
	var revoked sql.NullInt64
	err := row.Scan(&dev.ID, &dev.UserID, &dev.Certificate, &dev.SignatureKey, &dev.CreatedAt, &dev.LastSeenAt, &revoked, &dev.SealKey, &dev.EnrollProof, &dev.SealGeneration, &dev.SealProof)
	dev.RevokedAt = nullableInt(revoked)
	return dev, err
}

func scanPublicUser(row interface{ Scan(...any) error }) (*PublicUser, error) {
	var u PublicUser
	var lastSeen, banned, deleted, listed sql.NullInt64
	var owner, add sql.NullString
	var proof []byte
	var hide int
	if err := row.Scan(&u.ID, &u.Username, &u.Role, &u.IdentityKey, &u.KeyGeneration, &u.IdentityHead, &u.HpkeKey, &u.HpkeKeySig, &u.Profile, &u.ProfileSig,
		&lastSeen, &hide, &banned, &deleted, &u.CreatedAt, &u.UpdatedAt, &owner, &listed, &add, &proof); err != nil {
		return nil, err
	}
	if owner.Valid {
		u.Bot = &BotInfo{OwnerID: owner.String, Listed: listed.Int64 != 0, Add: add.String, Proof: proof}
	}
	u.HideLastSeen = hide != 0
	if !u.HideLastSeen {
		u.LastSeenAt = nullableInt(lastSeen)
	}
	u.Banned = banned.Valid
	u.Deleted = deleted.Valid
	u.Devices = []Device{}
	return &u, nil
}

// Users returns the users there for `viewer` that changed after `since` (Unix ms),
// with their active devices. A private bot is only there for its owner and for
// whoever is in a chat with it.
func (d *DB) Users(ctx context.Context, since int64, viewer string) ([]*PublicUser, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT `+publicUserColumns+` FROM `+publicUsers+` WHERE u.updated_at > ?1
			AND (b.id IS NULL OR b.listed = 1 OR b.owner_id = ?2 OR b.id = ?2 OR `+sharesChat+`?2))
			ORDER BY u.username_key`, since, viewer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []*PublicUser{}
	byID := map[string]*PublicUser{}
	for rows.Next() {
		u, err := scanPublicUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
		byID[u.ID] = u
	}
	if err := rows.Err(); err != nil || len(users) == 0 {
		return users, err
	}
	// Only the devices of those users: every app asks for this each time it connects, and
	// each device carries its certificate.
	deviceRows, err := d.sql.QueryContext(ctx, `SELECT `+deviceColumns+` FROM devices WHERE user_id IN (SELECT id FROM users WHERE updated_at > ?)`, since)
	if err != nil {
		return nil, err
	}
	defer deviceRows.Close()
	for deviceRows.Next() {
		dev, err := scanDevice(deviceRows)
		if err != nil {
			return nil, err
		}
		if u, ok := byID[dev.UserID]; ok {
			u.Devices = append(u.Devices, dev)
		}
	}
	return users, deviceRows.Err()
}

// UserRole is someone's server role, and whether their account was deleted, for
// checks that need no more of them.
func (d *DB) UserRole(ctx context.Context, id string) (string, bool, error) {
	var role string
	var deletedAt *int64
	err := d.sql.QueryRowContext(ctx, `SELECT role, deleted_at FROM users WHERE id = ?`, id).Scan(&role, &deletedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, ErrNotFound
	}
	return role, deletedAt != nil, err
}

func (d *DB) User(ctx context.Context, id string) (*PublicUser, error) {
	u, err := scanPublicUser(d.sql.QueryRowContext(ctx, `SELECT `+publicUserColumns+` FROM `+publicUsers+` WHERE u.id = ?`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT `+deviceColumns+` FROM devices WHERE user_id = ?`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		dev, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		u.Devices = append(u.Devices, dev)
	}
	return u, rows.Err()
}

// UserCount is how many people a server has. Bots don't count.
func (d *DB) UserCount(ctx context.Context) (int, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM users u WHERE u.banned_at IS NULL AND u.deleted_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = u.id)`).Scan(&n)
	return n, err
}

// UpdateProfile stores the user's encrypted profile. An avatar must be the
// user's own finished upload. It returns the avatar this replaced, if nothing
// else uses it, so it can be deleted.
func (d *DB) UpdateProfile(ctx context.Context, userID string, profile, profileSig []byte, avatarFile *string) (string, error) {
	var old sql.NullString
	var orphaned []string
	err := d.tx(ctx, func(tx handle) error {
		orphaned = nil
		if err := tx.QueryRowContext(ctx, `SELECT avatar_file FROM users WHERE id = ?`, userID).Scan(&old); err != nil {
			return err
		}
		if avatarFile != nil && (!old.Valid || old.String != *avatarFile) {
			var owner string
			var completed sql.NullInt64
			err := tx.QueryRowContext(ctx, `SELECT owner_id, completed_at FROM files WHERE id = ?`, *avatarFile).Scan(&owner, &completed)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && (owner != userID || !completed.Valid)) {
				return ErrForbidden
			}
			if err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET profile = ?, profile_sig = ?, avatar_file = ?, updated_at = ? WHERE id = ?`,
			profile, profileSig, avatarFile, Now(), userID); err != nil {
			return err
		}
		if avatarFile != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE files SET attached_at = ? WHERE id = ? AND owner_id = ?`, Now(), *avatarFile, userID); err != nil {
				return err
			}
		}
		if old.Valid && (avatarFile == nil || *avatarFile != old.String) {
			var err error
			orphaned, err = unreferenced(ctx, tx, []string{old.String})
			return err
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if len(orphaned) > 0 {
		return orphaned[0], nil
	}
	return "", nil
}

func (d *DB) SetHideLastSeen(ctx context.Context, userID string, hide bool) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE users SET hide_last_seen = ?, updated_at = ? WHERE id = ?`, hide, Now(), userID)
	return err
}

// LastSeenSince is when each person was last seen, of those last seen after since
// (Unix ms), leaving out those who hide it. Last seen moves without the rest of
// someone changing, so it isn't in what Users finds changed.
func (d *DB) LastSeenSince(ctx context.Context, since int64) (map[string]int64, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT id, last_seen_at FROM users WHERE last_seen_at > ? AND hide_last_seen = 0 AND deleted_at IS NULL`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]int64{}
	for rows.Next() {
		var id string
		var at int64
		if err := rows.Scan(&id, &at); err != nil {
			return nil, err
		}
		seen[id] = at
	}
	return seen, rows.Err()
}

// TouchLastSeen records when someone was last seen, on which device, unless
// their account was deleted meanwhile.
func (d *DB) TouchLastSeen(ctx context.Context, userID string, deviceID string, at int64) error {
	if _, err := d.sql.ExecContext(ctx, `UPDATE users SET last_seen_at = ? WHERE id = ? AND deleted_at IS NULL`, at, userID); err != nil {
		return err
	}
	if deviceID != "" {
		_, err := d.sql.ExecContext(ctx, `UPDATE devices SET last_seen_at = ? WHERE id = ?`, at, deviceID)
		return err
	}
	return nil
}

func (d *DB) SetRole(ctx context.Context, userID, role string) error {
	res, err := d.sql.ExecContext(ctx, `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, role, Now(), userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// BanUser marks the user banned by the admin bannedBy and ends all of their sessions.
func (d *DB) BanUser(ctx context.Context, userID, bannedBy string) error {
	return d.tx(ctx, func(tx handle) error {
		now := Now()
		res, err := tx.ExecContext(ctx, `UPDATE users SET banned_at = ?, banned_by = ?, updated_at = ? WHERE id = ?`, now, bannedBy, now, userID)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, now, userID); err != nil {
			return err
		}
		// What waits for their devices goes with them, as when one is removed or the account deleted.
		for _, query := range []string{
			`DELETE FROM key_packages WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
			`DELETE FROM welcomes WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
			`DELETE FROM account_bundles WHERE user_id = ?`,
			`DELETE FROM push_registrations WHERE user_id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, query, userID); err != nil {
				return err
			}
		}
		// Banning them is the answer to what they were reported for.
		if _, err := tx.ExecContext(ctx, `DELETE FROM reports WHERE user_id = ?`, userID); err != nil {
			return err
		}
		// An invite they made shouldn't be their way back in.
		if _, err := tx.ExecContext(ctx, `UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL`, now, userID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM group_members WHERE user_id = ?`, userID)
		return err
	})
}

// UnbanUser lets someone back in, and back into the direct messages the ban took
// them out of, which it returns. Groups are for their admins to add them to again,
// and channels each device joins by itself.
func (d *DB) UnbanUser(ctx context.Context, userID string) ([]string, error) {
	var dms []string
	err := d.tx(ctx, func(tx handle) error {
		dms = nil
		now := Now()
		if _, err := tx.ExecContext(ctx, `UPDATE users SET banned_at = NULL, banned_by = NULL, updated_at = ? WHERE id = ?`, now, userID); err != nil {
			return err
		}
		// A DM's key is its two people's IDs, which are hex, in order.
		rows, err := tx.QueryContext(ctx, `SELECT id FROM groups WHERE kind = 'dm' AND (dm_key LIKE ? OR dm_key LIKE ?)
			AND id NOT IN (SELECT group_id FROM group_members WHERE user_id = ?)`, userID+":%", "%:"+userID, userID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			dms = append(dms, id)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		rows.Close()
		for _, id := range dms {
			if _, err := tx.ExecContext(ctx, `INSERT INTO group_members(group_id, user_id, role, joined_at) VALUES(?, ?, 'admin', ?)`, id, userID, now); err != nil {
				return err
			}
		}
		return nil
	})
	return dms, err
}

// Ban is someone banned from the server: when, and by which admin.
type Ban struct {
	UserID   string `json:"user_id"`
	BannedAt int64  `json:"banned_at"`
	BannedBy string `json:"banned_by"`
}

// Bans lists who is banned, the latest first. An account deleted since is left out,
// as nothing can be done about it.
func (d *DB) Bans(ctx context.Context) ([]Ban, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, banned_at, COALESCE(banned_by, '') FROM users
		WHERE banned_at IS NOT NULL AND deleted_at IS NULL ORDER BY banned_at DESC, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bans := []Ban{}
	for rows.Next() {
		var ban Ban
		if err := rows.Scan(&ban.UserID, &ban.BannedAt, &ban.BannedBy); err != nil {
			return nil, err
		}
		bans = append(bans, ban)
	}
	return bans, rows.Err()
}

// DeleteAccount erases what an account keeps here, as its owner asked, and frees
// its username. What stays is what others need to go on reading what it sent: its
// ID, its public keys and its devices' certificates, all revoked. It returns its
// avatar, if nothing else uses it, so it can be deleted.
func (d *DB) DeleteAccount(ctx context.Context, userID string) (string, error) {
	var orphaned []string
	err := d.tx(ctx, func(tx handle) error {
		orphaned = nil
		var name string
		var avatar sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT username_key, avatar_file FROM users WHERE id = ? AND deleted_at IS NULL`, userID).Scan(&name, &avatar)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		now := Now()
		// No username has a colon, so nobody can sign up as what this one is now.
		empty := []byte{}
		if _, err := tx.ExecContext(ctx, `UPDATE users SET username = '', username_key = ?, role = 'member',
			kdf_salt = ?, auth_hash = ?, auth_salt = ?, recovery_hash = ?, recovery_salt = ?, vault_core = ?,
			profile = NULL, profile_sig = NULL, avatar_file = NULL, last_seen_at = NULL, deleted_at = ?, updated_at = ?
			WHERE id = ?`, "deleted:"+userID, empty, empty, empty, empty, empty, empty, now, now, userID); err != nil {
			return err
		}
		for _, statement := range []string{
			`DELETE FROM sessions WHERE user_id = ?`,
			`DELETE FROM key_packages WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
			`DELETE FROM welcomes WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`,
			`DELETE FROM account_bundles WHERE user_id = ?`,
			`DELETE FROM account_slots WHERE user_id = ?`,
			`DELETE FROM vault_items WHERE user_id = ?`,
			`DELETE FROM history_grants WHERE user_id = ?`,
			`DELETE FROM push_registrations WHERE user_id = ?`,
			`DELETE FROM group_members WHERE user_id = ?`,
			`DELETE FROM channel_sends WHERE user_id = ?`,
			`DELETE FROM reports WHERE user_id = ?`,
			// A bot's account going is the bot going.
			`DELETE FROM bot_channels WHERE bot_id = ?`,
		} {
			if _, err := tx.ExecContext(ctx, statement, userID); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, now, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invites SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL`, now, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sign_in_attempts WHERE account = ?`, name); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE bots SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`, now, userID); err != nil {
			return err
		}
		if avatar.Valid {
			orphaned, err = unreferenced(ctx, tx, []string{avatar.String})
		}
		return err
	})
	if err != nil || len(orphaned) == 0 {
		return "", err
	}
	return orphaned[0], nil
}

// --- Sessions ---
