package store

import (
	"context"
	"database/sql"
	"errors"
)

// Report is someone reported to the server's admins: who, why and when. Who
// reported them isn't kept.
type Report struct {
	UserID    string `json:"user_id"`
	Reason    string `json:"reason"`
	CreatedAt int64  `json:"created_at"`
}

// AddReport reports someone still on the server.
func (d *DB) AddReport(ctx context.Context, userID, reason string) error {
	return d.tx(ctx, func(tx handle) error {
		var gone sql.NullInt64
		err := tx.QueryRowContext(ctx, `SELECT COALESCE(banned_at, deleted_at) FROM users WHERE id = ?`, userID).Scan(&gone)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if gone.Valid {
			return ErrForbidden
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO reports(user_id, reason, created_at) VALUES(?, ?, ?)`, userID, reason, Now())
		return err
	})
}

// Reports lists every report, newest first.
func (d *DB) Reports(ctx context.Context) ([]Report, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT user_id, reason, created_at FROM reports ORDER BY created_at DESC, id DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	reports := []Report{}
	for rows.Next() {
		var report Report
		if err := rows.Scan(&report.UserID, &report.Reason, &report.CreatedAt); err != nil {
			return nil, err
		}
		reports = append(reports, report)
	}
	return reports, rows.Err()
}

// DismissReports forgets what someone was reported for.
func (d *DB) DismissReports(ctx context.Context, userID string) error {
	_, err := d.sql.ExecContext(ctx, `DELETE FROM reports WHERE user_id = ?`, userID)
	return err
}
