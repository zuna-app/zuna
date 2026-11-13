package store

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"time"

	"zuna/server/internal/tokens"
)

// The tokens that limit what an unnamed sender may send (internal/tokens). The server
// issues them to people it knows, counting each person's, and redeems them from
// requests that name nobody, which it can tell are its own and nothing else.

// TokenPeriod is how long a key issues tokens for. A token redeems in its own period
// and the next, so it lasts between one and two of them.
const TokenPeriod = 6 * time.Hour

const (
	// SmallToken is for an envelope up to SmallTokenBytes, LargeToken for any the server takes.
	SmallToken = "small"
	LargeToken = "large"
	// SmallTokenBytes holds any text message, and one with a picture's preview.
	SmallTokenBytes = 32 << 10
	// TokenLen is how long a token is as a request carries it: its period (8 bytes),
	// its size (1), its input and its output.
	TokenLen = 8 + 1 + tokens.InputLen + tokens.OutputLen
)

// TokenSizes are the sizes there are, smallest first.
var TokenSizes = []string{SmallToken, LargeToken}

var (
	// ErrTokenInvalid is for a token that isn't one of the server's, for its size and time.
	ErrTokenInvalid = errors.New("token invalid")
	// ErrTokenSpent is for a token that was redeemed already.
	ErrTokenSpent = errors.New("token spent")
	// ErrLargeToken is for a small token where only a large one will do, which the app
	// can't always tell beforehand, as for a reaction to a message that has many.
	ErrLargeToken = errors.New("large token needed")
)

// CurrentTokenPeriod is the period tokens are issued for now.
func CurrentTokenPeriod() int64 {
	return Now() / TokenPeriod.Milliseconds()
}

// TokenKey is the key tokens of one size are issued under in one period.
type TokenKey struct {
	Period int64  `json:"period"`
	Size   string `json:"size"`
	Public []byte `json:"public"`
	Secret []byte `json:"-"`
}

// TokenKeys gives a period's keys, smallest size first. With create, any it doesn't
// have yet are made at random, once, however many servers ask at once.
func (d *DB) TokenKeys(ctx context.Context, period int64, create bool) ([]TokenKey, error) {
	if create {
		err := d.tx(ctx, func(tx handle) error {
			for _, size := range TokenSizes {
				secret, public, err := tokens.NewKey()
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO token_keys(period, size, secret, public) VALUES(?, ?, ?, ?)
					ON CONFLICT(period, size) DO NOTHING`, period, size, secret, public); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT period, size, secret, public FROM token_keys WHERE period = ?`, period)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bySize := map[string]TokenKey{}
	for rows.Next() {
		var key TokenKey
		if err := rows.Scan(&key.Period, &key.Size, &key.Secret, &key.Public); err != nil {
			return nil, err
		}
		bySize[key.Size] = key
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	keys := []TokenKey{}
	for _, size := range TokenSizes {
		if key, ok := bySize[size]; ok {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

// IssueTokens counts n more tokens of a size issued to someone in a period, unless
// that would take them past limit, across all their devices.
func (d *DB) IssueTokens(ctx context.Context, userID string, period int64, size string, n, limit int) error {
	return d.tx(ctx, func(tx handle) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO token_issues(user_id, period, size, issued) VALUES(?, ?, ?, 0)
			ON CONFLICT(user_id, period, size) DO NOTHING`, userID, period, size); err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `UPDATE token_issues SET issued = issued + ?1 WHERE user_id = ?2 AND period = ?3 AND size = ?4 AND issued + ?1 <= ?5`,
			n, userID, period, size, limit)
		if err != nil {
			return err
		}
		if changed, _ := res.RowsAffected(); changed == 0 {
			return ErrLimit
		}
		return nil
	})
}

// Token is a token as a request redeems it.
type Token struct {
	Period int64
	Size   string
	Input  []byte
	Output []byte
}

// ParseToken reads a token as a request carries it, or gives nil for what isn't one.
func ParseToken(raw []byte) *Token {
	if len(raw) != TokenLen {
		return nil
	}
	var size string
	switch raw[8] {
	case 1:
		size = SmallToken
	case 2:
		size = LargeToken
	default:
		return nil
	}
	return &Token{
		Period: int64(binary.BigEndian.Uint64(raw[:8])),
		Size:   size,
		Input:  raw[9 : 9+tokens.InputLen],
		Output: raw[9+tokens.InputLen:],
	}
}

// TokenSizeFor is the smallest size of token that pays for something of n bytes.
func TokenSizeFor(n int) string {
	if n <= SmallTokenBytes {
		return SmallToken
	}
	return LargeToken
}

// spendToken redeems a token as part of a write, in the same transaction, so that a
// write refused costs nothing: one of the server's, of at least the size asked for,
// from this period or the last, and never redeemed before.
func spendToken(ctx context.Context, tx handle, t *Token, size string) error {
	current := CurrentTokenPeriod()
	if t == nil || (t.Period != current && t.Period != current-1) || (size == LargeToken && t.Size != LargeToken) {
		return ErrTokenInvalid
	}
	var secret []byte
	err := tx.QueryRowContext(ctx, `SELECT secret FROM token_keys WHERE period = ? AND size = ?`, t.Period, t.Size).Scan(&secret)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrTokenInvalid
	}
	if err != nil {
		return err
	}
	if !tokens.Redeems(secret, t.Input, t.Output) {
		return ErrTokenInvalid
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO spent_tokens(period, size, input) VALUES(?, ?, ?) ON CONFLICT DO NOTHING`, t.Period, t.Size, t.Input)
	if err != nil {
		return err
	}
	if changed, _ := res.RowsAffected(); changed == 0 {
		return ErrTokenSpent
	}
	return nil
}

// PruneTokens forgets the keys that can't redeem anything any more, with what was
// issued and spent under them.
func (d *DB) PruneTokens(ctx context.Context) error {
	before := CurrentTokenPeriod() - 1
	return d.tx(ctx, func(tx handle) error {
		for _, table := range []string{"spent_tokens", "token_issues", "token_keys"} {
			if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE period < ?`, before); err != nil {
				return err
			}
		}
		return nil
	})
}
