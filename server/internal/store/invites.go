package store

import (
	"context"
	"database/sql"
	"errors"
)

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
