package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"slices"
)

// Everything here is about generations of an account's keys, which the server
// orders and can't read. docs/ACCOUNT_KEY_ROTATION.md has the design.

// ErrDevicesChanged reports that a rotation doesn't account for the devices the
// account has now, so whoever sent it should look again.
var ErrDevicesChanged = errors.New("devices changed")

// GenerationConflictError reports that a request was for another generation of
// the account's keys than the current one.
type GenerationConflictError struct{ Current int64 }

func (e *GenerationConflictError) Error() string {
	return fmt.Sprintf("stale generation: account is at %d", e.Current)
}

// Slot is the public-key wrapper of an account key for a password or recovery key.
type Slot struct {
	Kind         string `json:"kind"`
	SealKey      []byte `json:"seal_key"`
	SignKey      []byte `json:"sign_key"`
	SealedSecret []byte `json:"sealed_secret"`
	SealedKey    []byte `json:"sealed_key"`
}

// IdentityLink moves an account from one generation to the next. Who signed what
// is for clients to check: to the server it's mostly opaque.
type IdentityLink struct {
	Generation int64  `json:"generation"`
	Payload    []byte `json:"payload"`
	ByPrev     []byte `json:"by_prev"`
	ByNew      []byte `json:"by_new"`
	ByDevice   []byte `json:"by_device"`
}

// Bundle is an account key sealed for one device.
type Bundle struct {
	DeviceID   string `json:"device_id"`
	Generation int64  `json:"generation"`
	Data       []byte `json:"data"`
}

// PasswordChange is new password material, proven already.
type PasswordChange struct {
	KDF      KDFParams
	AuthHash []byte
	AuthSalt []byte
}

// RecoveryChange is new recovery material, proven already.
type RecoveryChange struct {
	Hash []byte
	Salt []byte
}

// Rotation is everything that moves an account to its next generation, all of
// which happens or none of it.
type Rotation struct {
	UserID       string
	TokenHash    []byte
	Expected     int64
	Link         IdentityLink
	Carried      map[string][]byte
	Removed      []string
	IdentityHead []byte
	VaultCore    []byte
	ProfileSig   []byte
	Slots        []Slot
	Bundles      []Bundle
	Items        []VaultItem
	Password     *PasswordChange
	Recovery     *RecoveryChange
}

// AccountState is what a device needs to follow its account's generations.
type AccountState struct {
	Generation     int64    `json:"generation"`
	VaultCore      []byte   `json:"vault_core"`
	Bundle         *Bundle  `json:"bundle"`
	OlderItems     int64    `json:"older_items"`
	MissingBundles []string `json:"missing_bundles"`
}

func (d *DB) insertSlots(ctx context.Context, tx handle, userID string, slots []Slot) error {
	for _, slot := range slots {
		_, err := tx.ExecContext(ctx, `INSERT INTO account_slots(user_id, kind, seal_key, sign_key, sealed_secret, sealed_key) VALUES(?,?,?,?,?,?)
			ON CONFLICT(user_id, kind) DO UPDATE SET seal_key = excluded.seal_key, sign_key = excluded.sign_key,
				sealed_secret = excluded.sealed_secret, sealed_key = excluded.sealed_key`,
			userID, slot.Kind, slot.SealKey, slot.SignKey, slot.SealedSecret, slot.SealedKey)
		if err != nil {
			return err
		}
	}
	return nil
}

// SlotOf is a person's slot of a kind, or nil if they don't have one.
func (d *DB) SlotOf(ctx context.Context, userID, kind string) (*Slot, error) {
	slot := Slot{Kind: kind}
	err := d.sql.QueryRowContext(ctx, `SELECT seal_key, sign_key, sealed_secret, sealed_key FROM account_slots WHERE user_id = ? AND kind = ?`,
		userID, kind).Scan(&slot.SealKey, &slot.SignKey, &slot.SealedSecret, &slot.SealedKey)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &slot, nil
}

// Head is an account's generation, its current identity key and its newest link,
// which a rotation has to follow from. The identity key is the one the account
// began with until it first rotates, and there's no link until then.
func (d *DB) Head(ctx context.Context, userID string) (int64, []byte, *IdentityLink, error) {
	var generation int64
	var root, head []byte
	if err := d.sql.QueryRowContext(ctx, `SELECT key_generation, identity_key, identity_head FROM users WHERE id = ?`, userID).Scan(&generation, &root, &head); err != nil {
		return 0, nil, nil, err
	}
	if generation == 0 {
		return 0, root, nil, nil
	}
	links, err := d.IdentityLinks(ctx, userID, generation-1, 1)
	if err != nil {
		return 0, nil, nil, err
	}
	if len(links) == 0 {
		return 0, nil, nil, ErrNotFound
	}
	return generation, head, &links[0], nil
}

// IdentityLinks returns a person's links after a generation, oldest first.
func (d *DB) IdentityLinks(ctx context.Context, userID string, after int64, limit int) ([]IdentityLink, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT generation, payload, by_prev, by_new, by_device FROM identity_links
		WHERE user_id = ? AND generation > ? ORDER BY generation ASC LIMIT ?`, userID, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	links := []IdentityLink{}
	for rows.Next() {
		var link IdentityLink
		if err := rows.Scan(&link.Generation, &link.Payload, &link.ByPrev, &link.ByNew, &link.ByDevice); err != nil {
			return nil, err
		}
		links = append(links, link)
	}
	return links, rows.Err()
}

// ApplyRotation moves an account to its next generation in one transaction. A
// repeat of a rotation that already went through succeeds without doing anything,
// so a client that never heard the answer can simply send it again.
func (d *DB) ApplyRotation(ctx context.Context, rotation Rotation) error {
	return d.tx(ctx, func(tx handle) error {
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, rotation.UserID).Scan(&current); err != nil {
			return err
		}
		if current != rotation.Expected {
			var stored []byte
			err := tx.QueryRowContext(ctx, `SELECT payload FROM identity_links WHERE user_id = ? AND generation = ?`,
				rotation.UserID, rotation.Link.Generation).Scan(&stored)
			if err == nil && bytes.Equal(stored, rotation.Link.Payload) {
				return nil
			}
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			return &GenerationConflictError{Current: current}
		}

		rows, err := tx.QueryContext(ctx, `SELECT id, signature_key FROM devices WHERE user_id = ? AND revoked_at IS NULL`, rotation.UserID)
		if err != nil {
			return err
		}
		active := map[string][]byte{}
		for rows.Next() {
			var id string
			var key []byte
			if err := rows.Scan(&id, &key); err != nil {
				rows.Close()
				return err
			}
			active[id] = key
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for id, key := range rotation.Carried {
			if known, ok := active[id]; !ok || !bytes.Equal(known, key) {
				return ErrDevicesChanged
			}
		}
		for id := range active {
			if _, carried := rotation.Carried[id]; !carried && !slices.Contains(rotation.Removed, id) {
				return ErrDevicesChanged
			}
		}

		now := Now()
		if _, err := tx.ExecContext(ctx, `INSERT INTO identity_links(user_id, generation, payload, by_prev, by_new, by_device, created_at) VALUES(?,?,?,?,?,?,?)`,
			rotation.UserID, rotation.Link.Generation, rotation.Link.Payload, rotation.Link.ByPrev, rotation.Link.ByNew, rotation.Link.ByDevice, now); err != nil {
			return err
		}
		// The HPKE key of a generation is in its link, so the one an account began
		// with stays as it is.
		if _, err := tx.ExecContext(ctx, `UPDATE users SET key_generation = ?, identity_head = ?, vault_core = ?, profile_sig = ?, updated_at = ? WHERE id = ?`,
			rotation.Link.Generation, rotation.IdentityHead, rotation.VaultCore, rotation.ProfileSig, now, rotation.UserID); err != nil {
			return err
		}
		if err := d.insertSlots(ctx, tx, rotation.UserID, rotation.Slots); err != nil {
			return err
		}
		if p := rotation.Password; p != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE users SET kdf_salt = ?, kdf_memory = ?, kdf_iterations = ?, kdf_parallelism = ?, auth_hash = ?, auth_salt = ? WHERE id = ?`,
				p.KDF.Salt, p.KDF.Memory, p.KDF.Iterations, p.KDF.Parallelism, p.AuthHash, p.AuthSalt, rotation.UserID); err != nil {
				return err
			}
		}
		if r := rotation.Recovery; r != nil {
			if _, err := tx.ExecContext(ctx, `UPDATE users SET recovery_hash = ?, recovery_salt = ? WHERE id = ?`, r.Hash, r.Salt, rotation.UserID); err != nil {
				return err
			}
		}

		if _, err := tx.ExecContext(ctx, `DELETE FROM account_bundles WHERE user_id = ?`, rotation.UserID); err != nil {
			return err
		}
		for _, bundle := range rotation.Bundles {
			if _, carried := rotation.Carried[bundle.DeviceID]; !carried {
				return ErrDevicesChanged
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO account_bundles(device_id, user_id, generation, data) VALUES(?,?,?,?)`,
				bundle.DeviceID, rotation.UserID, rotation.Link.Generation, bundle.Data); err != nil {
				return err
			}
		}
		if err := putItems(ctx, tx, rotation.UserID, rotation.Items); err != nil {
			return err
		}
		for _, id := range rotation.Removed {
			if err := revokeDevice(ctx, tx, rotation.UserID, id, now); err != nil && !errors.Is(err, ErrNotFound) {
				return err
			}
		}
		// Whoever signed in and left nothing listed took the old keys with them.
		_, err = tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND device_id IS NULL AND token_hash != ?`, rotation.UserID, rotation.TokenHash)
		return err
	})
}

// Account is what one device needs to know about its account's keys.
func (d *DB) Account(ctx context.Context, userID, deviceID string) (*AccountState, error) {
	state := AccountState{MissingBundles: []string{}}
	if err := d.sql.QueryRowContext(ctx, `SELECT key_generation, vault_core FROM users WHERE id = ?`, userID).Scan(&state.Generation, &state.VaultCore); err != nil {
		return nil, err
	}
	var bundle Bundle
	err := d.sql.QueryRowContext(ctx, `SELECT device_id, generation, data FROM account_bundles WHERE device_id = ?`, deviceID).Scan(&bundle.DeviceID, &bundle.Generation, &bundle.Data)
	if err == nil {
		state.Bundle = &bundle
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM vault_items WHERE user_id = ? AND generation < ?`, userID, state.Generation).Scan(&state.OlderItems); err != nil {
		return nil, err
	}
	if state.Generation > 0 {
		rows, err := d.sql.QueryContext(ctx, `SELECT id FROM devices WHERE user_id = ? AND revoked_at IS NULL AND seal_key IS NOT NULL
			AND id NOT IN (SELECT device_id FROM account_bundles WHERE user_id = ? AND generation = ?)`, userID, userID, state.Generation)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			state.MissingBundles = append(state.MissingBundles, id)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return &state, nil
}

// PutBundles delivers the account key to devices that couldn't be sealed to when
// the generation was made, such as one that has since updated.
func (d *DB) PutBundles(ctx context.Context, userID string, generation int64, bundles []Bundle) error {
	return d.tx(ctx, func(tx handle) error {
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, userID).Scan(&current); err != nil {
			return err
		}
		if current != generation {
			return &GenerationConflictError{Current: current}
		}
		for _, bundle := range bundles {
			var owner string
			err := tx.QueryRowContext(ctx, `SELECT user_id FROM devices WHERE id = ? AND revoked_at IS NULL`, bundle.DeviceID).Scan(&owner)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && owner != userID) {
				return ErrForbidden
			}
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO account_bundles(device_id, user_id, generation, data) VALUES(?,?,?,?)
				ON CONFLICT(device_id) DO UPDATE SET generation = excluded.generation, data = excluded.data`,
				bundle.DeviceID, userID, generation, bundle.Data); err != nil {
				return err
			}
		}
		return nil
	})
}

// CloseGeneration replaces the core once nothing older is left in the vault.
func (d *DB) CloseGeneration(ctx context.Context, userID string, generation int64, core []byte) error {
	return d.tx(ctx, func(tx handle) error {
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, userID).Scan(&current); err != nil {
			return err
		}
		if current != generation {
			return &GenerationConflictError{Current: current}
		}
		var older int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM vault_items WHERE user_id = ? AND generation < ?`, userID, generation).Scan(&older); err != nil {
			return err
		}
		if older > 0 {
			return ErrConflict
		}
		_, err := tx.ExecContext(ctx, `UPDATE users SET vault_core = ? WHERE id = ?`, core, userID)
		return err
	})
}

// SetDeviceSealKey is a device saying what to seal account keys to from now on.
func (d *DB) SetDeviceSealKey(ctx context.Context, userID, deviceID string, key []byte, generation int64, proof []byte) error {
	return d.touchDevice(ctx, userID, deviceID, `UPDATE devices SET seal_key = ?, seal_generation = ?, seal_proof = ? WHERE id = ?`, key, generation, proof, deviceID)
}

// SetDeviceCertificate is a device publishing the certificate it has now.
func (d *DB) SetDeviceCertificate(ctx context.Context, userID, deviceID string, certificate []byte) error {
	return d.touchDevice(ctx, userID, deviceID, `UPDATE devices SET certificate = ? WHERE id = ?`, certificate, deviceID)
}

func (d *DB) touchDevice(ctx context.Context, userID, deviceID, query string, args ...any) error {
	return d.tx(ctx, func(tx handle) error {
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE users SET updated_at = ? WHERE id = ?`, Now(), userID)
		return err
	})
}

// VaultItems is the vault after a place in it, at whichever generation each item is.
func (d *DB) VaultItems(ctx context.Context, userID string, since int64, limit int) ([]VaultItem, error) {
	return d.vaultItems(ctx, `SELECT id, seq, generation, data FROM vault_items WHERE user_id = ? AND seq > ?
		ORDER BY seq ASC LIMIT ?`, userID, since, limit)
}

// OlderVaultItems are those not yet sealed under the current generation.
func (d *DB) OlderVaultItems(ctx context.Context, userID string, generation int64, limit int) ([]VaultItem, error) {
	return d.vaultItems(ctx, `SELECT id, seq, generation, data FROM vault_items WHERE user_id = ? AND generation < ?
		ORDER BY seq ASC LIMIT ?`, userID, generation, limit)
}

func (d *DB) vaultItems(ctx context.Context, query string, args ...any) ([]VaultItem, error) {
	rows, err := d.sql.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []VaultItem{}
	for rows.Next() {
		var item VaultItem
		if err := rows.Scan(&item.ID, &item.Seq, &item.Generation, &item.Data); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// PutVaultItemsAt stores items sealed under the given generation, which has to be
// the current one: a device behind it would be sealing to a key it should stop using.
func (d *DB) PutVaultItemsAt(ctx context.Context, userID string, generation int64, items []VaultItem, quota int64) (int64, error) {
	var seq int64
	err := d.tx(ctx, func(tx handle) error {
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, userID).Scan(&current); err != nil {
			return err
		}
		if current != generation {
			return &GenerationConflictError{Current: current}
		}
		for i := range items {
			items[i].Generation = generation
		}
		if err := countVaultItems(ctx, tx, userID, items, quota); err != nil {
			return err
		}
		if err := putItems(ctx, tx, userID, items); err != nil {
			return err
		}
		return tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(seq), 0) FROM vault_items WHERE user_id = ?`, userID).Scan(&seq)
	})
	return seq, err
}

// ResealVaultItems moves older items to the current generation, leaving their
// place in the feed alone: devices already hold what's in them. It can't lower an
// item's generation, and what shouldn't carry over is deleted.
func (d *DB) ResealVaultItems(ctx context.Context, userID string, generation int64, items []VaultItem, remove []string) error {
	return d.tx(ctx, func(tx handle) error {
		var current int64
		if err := tx.QueryRowContext(ctx, `SELECT key_generation FROM users WHERE id = ?`, userID).Scan(&current); err != nil {
			return err
		}
		if current != generation {
			return &GenerationConflictError{Current: current}
		}
		for _, item := range items {
			if _, err := tx.ExecContext(ctx, `UPDATE vault_items SET data = ?, generation = ? WHERE user_id = ? AND id = ? AND generation < ?`,
				item.Data, generation, userID, item.ID, generation); err != nil {
				return err
			}
		}
		for _, id := range remove {
			if _, err := tx.ExecContext(ctx, `DELETE FROM vault_items WHERE user_id = ? AND id = ? AND generation < ?`, userID, id, generation); err != nil {
				return err
			}
		}
		return nil
	})
}
