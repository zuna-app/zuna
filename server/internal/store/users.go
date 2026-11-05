package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// PublicUser is what every member of a server can see about a user.
type PublicUser struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Role        string `json:"role"`
	IdentityKey []byte `json:"identity_key"`
	// KeyGeneration, IdentityHead and ProfileSig are for clients that follow an
	// account's generations. Older ones go on seeing the key it began with.
	KeyGeneration int64    `json:"key_generation"`
	IdentityHead  []byte   `json:"identity_head"`
	HpkeKey       []byte   `json:"hpke_key"`
	HpkeKeySig    []byte   `json:"hpke_key_sig"`
	Profile       []byte   `json:"profile"`
	ProfileSig    []byte   `json:"profile_sig"`
	LastSeenAt    *int64   `json:"last_seen_at"`
	HideLastSeen  bool     `json:"hide_last_seen"`
	Banned        bool     `json:"banned"`
	CreatedAt     int64    `json:"created_at"`
	UpdatedAt     int64    `json:"updated_at"`
	Devices       []Device `json:"devices"`
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
// An empty inviteCode is only valid when open sign-ups are on.
func (d *DB) CreateUser(ctx context.Context, u NewUser, inviteCode string) (string, error) {
	id := NewID()
	now := Now()
	err := d.tx(ctx, func(tx *sql.Tx) error {
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

const publicUserColumns = `id, username, role, identity_key, key_generation, identity_head, hpke_key, hpke_key_sig, profile, profile_sig,
	last_seen_at, hide_last_seen, banned_at, created_at, updated_at`

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
	var lastSeen, banned sql.NullInt64
	var hide int
	if err := row.Scan(&u.ID, &u.Username, &u.Role, &u.IdentityKey, &u.KeyGeneration, &u.IdentityHead, &u.HpkeKey, &u.HpkeKeySig, &u.Profile, &u.ProfileSig,
		&lastSeen, &hide, &banned, &u.CreatedAt, &u.UpdatedAt); err != nil {
		return nil, err
	}
	u.HideLastSeen = hide != 0
	if !u.HideLastSeen {
		u.LastSeenAt = nullableInt(lastSeen)
	}
	u.Banned = banned.Valid
	u.Devices = []Device{}
	return &u, nil
}

// Users returns users changed after `since` (Unix ms), with their active devices.
func (d *DB) Users(ctx context.Context, since int64) ([]*PublicUser, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT `+publicUserColumns+` FROM users WHERE updated_at > ? ORDER BY username_key`, since)
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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	deviceRows, err := d.sql.QueryContext(ctx, `SELECT `+deviceColumns+` FROM devices`)
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

func (d *DB) User(ctx context.Context, id string) (*PublicUser, error) {
	u, err := scanPublicUser(d.sql.QueryRowContext(ctx, `SELECT `+publicUserColumns+` FROM users WHERE id = ?`, id))
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

func (d *DB) UserCount(ctx context.Context) (int, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE banned_at IS NULL`).Scan(&n)
	return n, err
}

// UpdateProfile stores the user's encrypted profile. An avatar must be the
// user's own finished upload. It returns the avatar this replaced, if nothing
// else uses it, so it can be deleted.
func (d *DB) UpdateProfile(ctx context.Context, userID string, profile, profileSig []byte, avatarFile *string) (string, error) {
	var old sql.NullString
	var orphaned []string
	err := d.tx(ctx, func(tx *sql.Tx) error {
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

func (d *DB) TouchLastSeen(ctx context.Context, userID string, deviceID string, at int64) error {
	if _, err := d.sql.ExecContext(ctx, `UPDATE users SET last_seen_at = ? WHERE id = ?`, at, userID); err != nil {
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

// BanUser marks the user banned and ends all of their sessions.
func (d *DB) BanUser(ctx context.Context, userID string) error {
	return d.tx(ctx, func(tx *sql.Tx) error {
		now := Now()
		res, err := tx.ExecContext(ctx, `UPDATE users SET banned_at = ?, updated_at = ? WHERE id = ?`, now, now, userID)
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
		if _, err := tx.ExecContext(ctx, `DELETE FROM key_packages WHERE device_id IN (SELECT id FROM devices WHERE user_id = ?)`, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM push_registrations WHERE user_id = ?`, userID); err != nil {
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

func (d *DB) UnbanUser(ctx context.Context, userID string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE users SET banned_at = NULL, updated_at = ? WHERE id = ?`, Now(), userID)
	return err
}

// --- Sessions ---

func (d *DB) CreateSession(ctx context.Context, tokenHash []byte, userID string) error {
	now := Now()
	_, err := d.sql.ExecContext(ctx, `INSERT INTO sessions(token_hash, user_id, created_at, last_used_at) VALUES(?,?,?,?)`,
		tokenHash, userID, now, now)
	return err
}

// Session is an authenticated request's identity.
type Session struct {
	UserID   string
	DeviceID string
	Username string
	Role     string
}

const (
	// A session without a device is only the moment between signing in and
	// registering one. It appears nowhere the person could notice it, so it
	// doesn't get to last.
	devicelessSessionLife = 10 * time.Minute
	// A session nobody has used for this long is over.
	sessionIdleLife = 365 * 24 * time.Hour
	// When a session was last used is written at most this often.
	lastUsedResolution = time.Hour
)

func (d *DB) SessionByToken(ctx context.Context, tokenHash []byte) (*Session, error) {
	var s Session
	var device sql.NullString
	var createdAt, lastUsedAt int64
	err := d.sql.QueryRowContext(ctx, `SELECT s.user_id, s.device_id, u.username, u.role, s.created_at, s.last_used_at
		FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = ? AND u.banned_at IS NULL`, tokenHash).Scan(&s.UserID, &device, &s.Username, &s.Role, &createdAt, &lastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	now := Now()
	if (!device.Valid && now-createdAt > devicelessSessionLife.Milliseconds()) || now-lastUsedAt > sessionIdleLife.Milliseconds() {
		return nil, ErrNotFound
	}
	if now-lastUsedAt > lastUsedResolution.Milliseconds() {
		if _, err := d.sql.ExecContext(ctx, `UPDATE sessions SET last_used_at = ? WHERE token_hash = ?`, now, tokenHash); err != nil {
			return nil, err
		}
	}
	s.DeviceID = device.String
	return &s, nil
}

func (d *DB) DeleteSession(ctx context.Context, tokenHash []byte) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteExpiredSessions forgets sessions that no longer work.
func (d *DB) DeleteExpiredSessions(ctx context.Context) error {
	now := Now()
	_, err := d.sql.ExecContext(ctx, `DELETE FROM sessions WHERE (device_id IS NULL AND created_at < ?) OR last_used_at < ?`,
		now-devicelessSessionLife.Milliseconds(), now-sessionIdleLife.Milliseconds())
	return err
}

// SignInAttempts is what's kept of one account's sign-in attempts, as Unix milliseconds.
type SignInAttempts struct {
	Account  string
	Attempts int
	Until    int64
	Seen     int64
}

// RecentSignInAttempts lists the accounts tried since a moment.
func (d *DB) RecentSignInAttempts(ctx context.Context, since int64) ([]SignInAttempts, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT account, attempts, until_at, seen_at FROM sign_in_attempts WHERE seen_at >= ?`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SignInAttempts
	for rows.Next() {
		var a SignInAttempts
		if err := rows.Scan(&a.Account, &a.Attempts, &a.Until, &a.Seen); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (d *DB) SaveSignInAttempts(ctx context.Context, a SignInAttempts) error {
	_, err := d.sql.ExecContext(ctx, `INSERT INTO sign_in_attempts(account, attempts, until_at, seen_at) VALUES(?,?,?,?)
		ON CONFLICT(account) DO UPDATE SET attempts = excluded.attempts, until_at = excluded.until_at, seen_at = excluded.seen_at`,
		a.Account, a.Attempts, a.Until, a.Seen)
	return err
}

// DeleteSignInAttemptsBefore forgets accounts nobody has tried since a moment.
func (d *DB) DeleteSignInAttemptsBefore(ctx context.Context, before int64) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM sign_in_attempts WHERE seen_at < ?`, before)
	return err
}

// --- Devices ---

// DeviceKey is the key a device signs its requests with.
func (d *DB) DeviceKey(ctx context.Context, deviceID string) ([]byte, error) {
	var key []byte
	err := d.sql.QueryRowContext(ctx, `SELECT signature_key FROM devices WHERE id = ? AND revoked_at IS NULL`, deviceID).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return key, err
}

// AddDevice registers a device and binds the current session to it. A device
// signing in says which generation of keys it got, since a rotation may have got
// in first.
func (d *DB) AddDevice(ctx context.Context, tokenHash []byte, dev Device, generation int64) error {
	return d.tx(ctx, func(tx *sql.Tx) error {
		now := Now()
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, dev.UserID).Scan(&current); err != nil {
			return err
		}
		if generation != current {
			return &GenerationConflictError{Current: current}
		}
		// Everyone who talks to this person has to deal with each of these.
		var active, ever int
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(revoked_at IS NULL), 0), COUNT(*) FROM devices WHERE user_id = ?`, dev.UserID).Scan(&active, &ever); err != nil {
			return err
		}
		if active >= maxActiveDevices || ever >= maxDevicesEver {
			return ErrLimit
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO devices(id, user_id, certificate, signature_key, created_at, last_seen_at, seal_key, enroll_proof, seal_generation, seal_proof)
			VALUES(?,?,?,?,?,?,?,?,?,?)`, dev.ID, dev.UserID, dev.Certificate, dev.SignatureKey, now, now, dev.SealKey, dev.EnrollProof, dev.SealGeneration, dev.SealProof)
		if isUniqueViolation(err) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sessions SET device_id = ? WHERE token_hash = ?`, dev.ID, tokenHash); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE users SET updated_at = ? WHERE id = ?`, now, dev.UserID)
		return err
	})
}

// RevokeDevice removes a device of the user and ends its sessions.
func (d *DB) RevokeDevice(ctx context.Context, userID, deviceID string) error {
	return d.tx(ctx, func(tx *sql.Tx) error {
		return revokeDevice(ctx, tx, userID, deviceID, Now())
	})
}

func revokeDevice(ctx context.Context, tx *sql.Tx, userID, deviceID string, now int64) error {
	res, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		now, deviceID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	for _, table := range []string{"sessions", "key_packages", "push_registrations", "account_bundles"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE device_id = ?`, deviceID); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE users SET updated_at = ? WHERE id = ?`, now, userID)
	return err
}

// --- Key packages ---

func (d *DB) AddKeyPackages(ctx context.Context, deviceID string, packages [][]byte, lastResort []byte) error {
	return d.tx(ctx, func(tx *sql.Tx) error {
		now := Now()
		for _, data := range packages {
			if _, err := tx.ExecContext(ctx, `INSERT INTO key_packages(device_id, data, last_resort, created_at) VALUES(?,?,0,?)`,
				deviceID, data, now); err != nil {
				return err
			}
		}
		if lastResort != nil {
			if _, err := tx.ExecContext(ctx, `DELETE FROM key_packages WHERE device_id = ? AND last_resort = 1`, deviceID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO key_packages(device_id, data, last_resort, created_at) VALUES(?,?,1,?)`,
				deviceID, lastResort, now); err != nil {
				return err
			}
		}
		return nil
	})
}

// KeyPackageStatus reports how many one-time packages a device has left and
// when its last-resort package was uploaded.
func (d *DB) KeyPackageStatus(ctx context.Context, deviceID string) (count int, lastResortAt int64, err error) {
	var at sql.NullInt64
	err = d.sql.QueryRowContext(ctx, `SELECT
		COALESCE(SUM(CASE WHEN last_resort = 0 THEN 1 ELSE 0 END), 0),
		MAX(CASE WHEN last_resort = 1 THEN created_at END)
		FROM key_packages WHERE device_id = ?`, deviceID).Scan(&count, &at)
	return count, at.Int64, err
}

// ClaimedKeyPackage is a key package reserved for adding one device to a group.
type ClaimedKeyPackage struct {
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
	Data     []byte `json:"data"`
}

// ClaimKeyPackages returns one key package per active device of the user.
// One-time packages are consumed; the last-resort package is reused.
func (d *DB) ClaimKeyPackages(ctx context.Context, userID string) ([]ClaimedKeyPackage, error) {
	claimed := []ClaimedKeyPackage{}
	err := d.tx(ctx, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL`, userID)
		if err != nil {
			return err
		}
		var devices []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			devices = append(devices, id)
		}
		rows.Close()
		for _, deviceID := range devices {
			var id int64
			var data []byte
			var lastResort int
			err := tx.QueryRowContext(ctx, `SELECT id, data, last_resort FROM key_packages WHERE device_id = ?
				ORDER BY last_resort ASC, id ASC LIMIT 1`, deviceID).Scan(&id, &data, &lastResort)
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			if lastResort == 0 {
				if _, err := tx.ExecContext(ctx, `DELETE FROM key_packages WHERE id = ?`, id); err != nil {
					return err
				}
			}
			claimed = append(claimed, ClaimedKeyPackage{UserID: userID, DeviceID: deviceID, Data: data})
		}
		return nil
	})
	return claimed, err
}

// --- Vault ---

// VaultItem is an opaque blob, encrypted under the user's account key of its
// generation. The generation is only a hint: a wrong one makes it fail to open.
type VaultItem struct {
	ID         string `json:"id"`
	Seq        int64  `json:"seq"`
	Generation int64  `json:"generation"`
	Data       []byte `json:"data"`
}

func countVaultItems(ctx context.Context, tx *sql.Tx, userID string, items []VaultItem, quota int64) error {
	var size int64
	for _, item := range items {
		size += int64(len(item.Data))
	}
	return countBytes(ctx, tx, storedBytes, userID, size, quota)
}

func putItems(ctx context.Context, tx *sql.Tx, userID string, items []VaultItem) error {
	var seq int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM vault_items WHERE user_id = ?`, userID).Scan(&seq); err != nil {
		return err
	}
	for _, item := range items {
		seq++
		if _, err := tx.ExecContext(ctx, `INSERT INTO vault_items(user_id, id, seq, generation, data) VALUES(?,?,?,?,?)
			ON CONFLICT(user_id, id) DO UPDATE SET seq = excluded.seq, generation = excluded.generation, data = excluded.data`,
			userID, item.ID, seq, item.Generation, item.Data); err != nil {
			return err
		}
	}
	return nil
}

// VaultItemCount is how many items someone keeps in their vault.
func (d *DB) VaultItemCount(ctx context.Context, userID string) (int, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM vault_items WHERE user_id = ?`, userID).Scan(&n)
	return n, err
}

// KeyGeneration is which generation of its keys an account is at.
func (d *DB) KeyGeneration(ctx context.Context, userID string) (int64, error) {
	var generation int64
	err := d.sql.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, userID).Scan(&generation)
	return generation, err
}

// --- Invites ---

type Invite struct {
	Code       string `json:"code"`
	CreatedBy  string `json:"created_by"`
	GrantsRole string `json:"grants_role"`
	MaxUses    int    `json:"max_uses"`
	Uses       int    `json:"uses"`
	ExpiresAt  *int64 `json:"expires_at"`
	CreatedAt  int64  `json:"created_at"`
}

func (d *DB) CreateInvite(ctx context.Context, code, createdBy, grantsRole string, maxUses int, expiresAt *int64) error {
	var creator any
	if createdBy != "" {
		creator = createdBy
	}
	_, err := d.sql.ExecContext(ctx, `INSERT INTO invites(code, created_by, grants_role, max_uses, expires_at, created_at)
		VALUES(?,?,?,?,?,?)`, code, creator, grantsRole, maxUses, expiresAt, Now())
	return err
}

// ValidInvite returns the invite if it can still be used.
func (d *DB) ValidInvite(ctx context.Context, code string) (*Invite, error) {
	var inv Invite
	var createdBy sql.NullString
	var expires, revoked sql.NullInt64
	err := d.sql.QueryRowContext(ctx, `SELECT code, created_by, grants_role, max_uses, uses, expires_at, revoked_at, created_at
		FROM invites WHERE code = ?`, code).Scan(&inv.Code, &createdBy, &inv.GrantsRole, &inv.MaxUses, &inv.Uses, &expires, &revoked, &inv.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	inv.CreatedBy = createdBy.String
	inv.ExpiresAt = nullableInt(expires)
	if revoked.Valid || (expires.Valid && expires.Int64 < Now()) || (inv.MaxUses > 0 && inv.Uses >= inv.MaxUses) {
		return nil, ErrNotFound
	}
	return &inv, nil
}

// Invites lists the invites that can still be used. With createdBy set, only that person's.
func (d *DB) Invites(ctx context.Context, createdBy string) ([]Invite, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT code, created_by, grants_role, max_uses, uses, expires_at, created_at
		FROM invites WHERE revoked_at IS NULL AND grants_role != 'owner'
		AND (expires_at IS NULL OR expires_at > ?1) AND (max_uses = 0 OR uses < max_uses)
		AND (?2 = '' OR created_by = ?2)
		ORDER BY created_at DESC`, Now(), createdBy)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	invites := []Invite{}
	for rows.Next() {
		var inv Invite
		var createdBy sql.NullString
		var expires sql.NullInt64
		if err := rows.Scan(&inv.Code, &createdBy, &inv.GrantsRole, &inv.MaxUses, &inv.Uses, &expires, &inv.CreatedAt); err != nil {
			return nil, err
		}
		inv.CreatedBy = createdBy.String
		inv.ExpiresAt = nullableInt(expires)
		invites = append(invites, inv)
	}
	return invites, rows.Err()
}

// RevokeInvite stops an invite working. With createdBy set, only if it's theirs.
func (d *DB) RevokeInvite(ctx context.Context, code, createdBy string) error {
	res, err := d.sql.ExecContext(ctx, `UPDATE invites SET revoked_at = ?1 WHERE code = ?2 AND (?3 = '' OR created_by = ?3)`, Now(), code, createdBy)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetupInvite returns the unused owner invite, if the server is still unclaimed.
func (d *DB) SetupInvite(ctx context.Context) (string, error) {
	var code string
	err := d.sql.QueryRowContext(ctx, `SELECT code FROM invites WHERE grants_role = 'owner' AND uses = 0 AND revoked_at IS NULL`).Scan(&code)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return code, err
}

// HasOwner reports whether the server has been claimed.
func (d *DB) HasOwner(ctx context.Context) (bool, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = 'owner'`).Scan(&n)
	return n > 0, err
}
