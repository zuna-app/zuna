package store

import (
	"context"
	"slices"
	"strings"
)

// PushRegistration is where to wake one device for new messages.
type PushRegistration struct {
	DeviceID string
	UserID   string
	// Relay is the push relay that reaches the device, one this server allows.
	Relay string
	// Handle is the relay's opaque name for the device.
	Handle string
	// Key seals each push, so the relay and Apple or Google see only that one arrived.
	Key []byte
	// Registration is the app's own ID for it, which tells the app which server a push is from.
	Registration string
	// Muted lists groups not to push for, while the app can't filter notifications itself.
	Muted []string
}

// SetPushRegistration stores a device's registration, replacing any earlier one.
func (d *DB) SetPushRegistration(ctx context.Context, p PushRegistration) error {
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO push_registrations(device_id, user_id, relay, handle, push_key, registration, muted, updated_at)
		 VALUES(?,?,?,?,?,?,?,?)
		 ON CONFLICT(device_id) DO UPDATE SET relay = excluded.relay, handle = excluded.handle, push_key = excluded.push_key,
		   registration = excluded.registration, muted = excluded.muted, updated_at = excluded.updated_at`,
		p.DeviceID, p.UserID, p.Relay, p.Handle, p.Key, p.Registration, strings.Join(p.Muted, ","), Now())
	return err
}

// DeletePushRegistration stops pushes to a device. With a handle, only if the
// device still has that one, so a newer registration isn't lost.
func (d *DB) DeletePushRegistration(ctx context.Context, deviceID, handle string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM push_registrations WHERE device_id = ? AND (? = '' OR handle = ?)`, deviceID, handle, handle)
	return err
}

// PushTargets lists the registered devices to wake for a new message in a
// group: the other members' devices that are signed in and haven't muted it.
func (d *DB) PushTargets(ctx context.Context, groupID, senderUserID string) ([]PushRegistration, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT p.device_id, p.user_id, p.relay, p.handle, p.push_key, p.registration, p.muted
		 FROM push_registrations p
		 JOIN group_members m ON m.user_id = p.user_id AND m.group_id = ?
		 JOIN devices dv ON dv.id = p.device_id AND dv.revoked_at IS NULL
		 JOIN users u ON u.id = p.user_id AND u.banned_at IS NULL
		 WHERE p.user_id != ? AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = p.device_id)`,
		groupID, senderUserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var targets []PushRegistration
	for rows.Next() {
		var p PushRegistration
		var muted string
		if err := rows.Scan(&p.DeviceID, &p.UserID, &p.Relay, &p.Handle, &p.Key, &p.Registration, &muted); err != nil {
			return nil, err
		}
		if muted != "" {
			p.Muted = strings.Split(muted, ",")
		}
		if !slices.Contains(p.Muted, groupID) {
			targets = append(targets, p)
		}
	}
	return targets, rows.Err()
}
