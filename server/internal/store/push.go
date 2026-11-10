package store

import (
	"context"
	"strconv"
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
	// CallHandle is the relay's name for the device's VoIP token, which calls ring
	// through, or empty if it has none.
	CallHandle string
	// Key seals each push, so the relay and Apple or Google see only that one arrived.
	Key []byte
	// Registration is the app's own ID for it, which tells the app which server a push is from.
	Registration string
	// Muted lists groups not to push for, while the app can't filter
	// notifications itself, with when each one's mute ends (ms), or 0 for
	// until it's unmuted.
	Muted map[string]int64
	// Filters is set when the app hides what it shouldn't show itself, so
	// it's pushed for everything, channels too.
	Filters bool
}

// encodeMuted stores mutes as "group" or "group:until", comma-separated.
func encodeMuted(muted map[string]int64) string {
	entries := make([]string, 0, len(muted))
	for groupID, until := range muted {
		if until > 0 {
			entries = append(entries, groupID+":"+strconv.FormatInt(until, 10))
		} else {
			entries = append(entries, groupID)
		}
	}
	return strings.Join(entries, ",")
}

func decodeMuted(value string) map[string]int64 {
	muted := map[string]int64{}
	for _, entry := range strings.Split(value, ",") {
		groupID, until, _ := strings.Cut(entry, ":")
		if groupID == "" {
			continue
		}
		muted[groupID], _ = strconv.ParseInt(until, 10, 64)
	}
	return muted
}

// Mutes reports whether a registration's mutes cover the group now.
func (p PushRegistration) Mutes(groupID string, now int64) bool {
	until, ok := p.Muted[groupID]
	return ok && (until == 0 || until > now)
}

// SetPushRegistration stores a device's registration, replacing any earlier one.
func (d *DB) SetPushRegistration(ctx context.Context, p PushRegistration) error {
	_, err := d.sql.ExecContext(ctx,
		`INSERT INTO push_registrations(device_id, user_id, relay, handle, call_handle, push_key, registration, muted, filters, updated_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(device_id) DO UPDATE SET relay = excluded.relay, handle = excluded.handle, call_handle = excluded.call_handle, push_key = excluded.push_key,
		   registration = excluded.registration, muted = excluded.muted, filters = excluded.filters, updated_at = excluded.updated_at`,
		p.DeviceID, p.UserID, p.Relay, p.Handle, p.CallHandle, p.Key, p.Registration, encodeMuted(p.Muted), p.Filters, Now())
	return err
}

// DeletePushRegistration stops pushes to a device. With a handle, only if the
// device still has that one, so a newer registration isn't lost.
func (d *DB) DeletePushRegistration(ctx context.Context, deviceID, handle string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM push_registrations WHERE device_id = ? AND (? = '' OR handle = ?)`, deviceID, handle, handle)
	return err
}

// SetPushNotified keeps the groups a device was sent a notification for and hasn't
// been told to clear, for as long as it's registered.
func (d *DB) SetPushNotified(ctx context.Context, deviceID string, groupIDs []string) error {
	_, err := d.sql.ExecContext(ctx, `UPDATE push_registrations SET notified = ? WHERE device_id = ?`, strings.Join(groupIDs, ","), deviceID)
	return err
}

// PushNotified lists those groups for every registered device that has any.
func (d *DB) PushNotified(ctx context.Context) (map[string][]string, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT device_id, notified FROM push_registrations WHERE notified != ''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	notified := map[string][]string{}
	for rows.Next() {
		var deviceID, groups string
		if err := rows.Scan(&deviceID, &groups); err != nil {
			return nil, err
		}
		notified[deviceID] = strings.Split(groups, ",")
	}
	return notified, rows.Err()
}

// PushTargets lists the registered devices to wake for a new message in a
// group: the members' devices that are signed in and haven't muted it, the sender's
// own among them, as nothing says who that is. Its read at once spares them (pushHold).
// With onlyFiltering, only those whose app hides what it shouldn't show.
func (d *DB) PushTargets(ctx context.Context, groupID string, onlyFiltering bool) ([]PushRegistration, error) {
	rows, err := d.sql.QueryContext(ctx,
		`SELECT p.device_id, p.user_id, p.relay, p.handle, p.push_key, p.registration, p.muted, p.filters
		 FROM push_registrations p
		 JOIN group_members m ON m.user_id = p.user_id AND m.group_id = ?
		 JOIN devices dv ON dv.id = p.device_id AND dv.revoked_at IS NULL
		 JOIN users u ON u.id = p.user_id AND u.banned_at IS NULL
		 WHERE (? = 0 OR p.filters = 1) AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = p.device_id)`,
		groupID, onlyFiltering)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var targets []PushRegistration
	now := Now()
	for rows.Next() {
		var p PushRegistration
		var muted string
		if err := rows.Scan(&p.DeviceID, &p.UserID, &p.Relay, &p.Handle, &p.Key, &p.Registration, &muted, &p.Filters); err != nil {
			return nil, err
		}
		p.Muted = decodeMuted(muted)
		if !p.Mutes(groupID, now) {
			targets = append(targets, p)
		}
	}
	return targets, rows.Err()
}

// PushRegistrationsOf lists the registered devices of these people that are signed in.
func (d *DB) PushRegistrationsOf(ctx context.Context, userIDs []string) ([]PushRegistration, error) {
	if len(userIDs) == 0 {
		return nil, nil
	}
	args := make([]any, len(userIDs))
	for i, id := range userIDs {
		args[i] = id
	}
	rows, err := d.sql.QueryContext(ctx,
		`SELECT p.device_id, p.user_id, p.relay, p.handle, p.call_handle, p.push_key, p.registration, p.muted
		 FROM push_registrations p
		 JOIN devices dv ON dv.id = p.device_id AND dv.revoked_at IS NULL
		 WHERE p.user_id IN (`+placeholders(len(userIDs))+`) AND EXISTS (SELECT 1 FROM sessions s WHERE s.device_id = p.device_id)`,
		args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var registrations []PushRegistration
	for rows.Next() {
		var p PushRegistration
		var muted string
		if err := rows.Scan(&p.DeviceID, &p.UserID, &p.Relay, &p.Handle, &p.CallHandle, &p.Key, &p.Registration, &muted); err != nil {
			return nil, err
		}
		p.Muted = decodeMuted(muted)
		registrations = append(registrations, p)
	}
	return registrations, rows.Err()
}
