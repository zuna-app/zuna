package store

import (
	"context"
	"database/sql"
	"errors"
)

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
	return d.tx(ctx, func(tx handle) error {
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
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END), 0), COUNT(*) FROM devices WHERE user_id = ?`, dev.UserID).Scan(&active, &ever); err != nil {
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
	return d.tx(ctx, func(tx handle) error {
		return revokeDevice(ctx, tx, userID, deviceID, Now())
	})
}

func revokeDevice(ctx context.Context, tx handle, userID, deviceID string, now int64) error {
	res, err := tx.ExecContext(ctx, `UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
		now, deviceID, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	// Devices are never deleted, only revoked, so the cascade on welcomes never comes.
	for _, table := range []string{"sessions", "key_packages", "push_registrations", "account_bundles", "welcomes"} {
		if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE device_id = ?`, deviceID); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE users SET updated_at = ? WHERE id = ?`, now, userID)
	return err
}

// --- Key packages ---

// AddKeyPackages keeps a device's new key packages, unless that would leave it more
// than `most` one-time ones, which ErrLimit says. The count is taken in the same
// transaction, so requests sent together can't get past it.
func (d *DB) AddKeyPackages(ctx context.Context, deviceID string, packages [][]byte, lastResort []byte, most int) error {
	return d.tx(ctx, func(tx handle) error {
		var held int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM key_packages WHERE device_id = ? AND last_resort = 0`, deviceID).Scan(&held); err != nil {
			return err
		}
		if held+len(packages) > most {
			return ErrLimit
		}
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
// One-time packages are consumed; the last-resort package is reused. A bot's are
// only for whoever may bring it into the chat they're for, which groupID names.
func (d *DB) ClaimKeyPackages(ctx context.Context, userID, claimer, groupID string, serverAdmin bool) ([]ClaimedKeyPackage, error) {
	var claimed []ClaimedKeyPackage
	err := d.tx(ctx, func(tx handle) error {
		claimed = []ClaimedKeyPackage{}
		if err := mayClaim(ctx, tx, userID, claimer, groupID, serverAdmin); err != nil {
			return err
		}
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
