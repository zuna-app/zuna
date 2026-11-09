package store

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"strings"
)

// Who may add a bot to a group, as its owner chose. A private bot's is always its owner.
const (
	BotAddOwner  = "owner"
	BotAddAdmins = "admins"
	BotAddAnyone = "anyone"
)

func ValidBotAdd(policy string) bool {
	return policy == BotAddOwner || policy == BotAddAdmins || policy == BotAddAnyone
}

// Bot is an account a program runs, as its owner and the server's admins see it.
// Until that program has signed up with its setup link, it's waiting, and has no
// account yet.
type Bot struct {
	ID       string `json:"id"`
	OwnerID  string `json:"owner_id"`
	Username string `json:"username"`
	// Listed for everyone on the server, or private: only for its owner and for
	// whoever is in a chat with it.
	Listed bool   `json:"listed"`
	Add    string `json:"add"`
	// Whether it may send files.
	Files     bool     `json:"files"`
	Channels  []string `json:"channels"`
	SetUp     bool     `json:"set_up"`
	CreatedAt int64    `json:"created_at"`
}

// BotInfo is what goes with a bot's account to whoever may see it.
type BotInfo struct {
	OwnerID string `json:"owner_id"`
	Listed  bool   `json:"listed"`
	Add     string `json:"add"`
	// Proof is the bot's signature on its identity key, by a key only its setup
	// link held. It's for its owner, whose app holds what checks it.
	Proof []byte `json:"proof,omitempty"`
}

// BotRules is what the server holds a bot to.
type BotRules struct {
	OwnerID string
	Listed  bool
	Add     string
	Files   bool
}

// MayBeAddedBy says whether someone may add the bot to a group: its owner always,
// and for a listed bot whoever its owner chose.
func (b *BotRules) MayBeAddedBy(userID string, serverAdmin bool) bool {
	return botAddAllowed(b.OwnerID, b.Add, b.Listed, userID, serverAdmin)
}

func botAddAllowed(owner, policy string, listed bool, userID string, serverAdmin bool) bool {
	return userID == owner || (listed && (policy == BotAddAnyone || (policy == BotAddAdmins && serverAdmin)))
}

const botColumns = `id, owner_id, username, listed, add_policy, files, created_at, set_up_at`

func scanBot(row interface{ Scan(...any) error }) (*Bot, error) {
	var b Bot
	var listed, files int
	var setUp sql.NullInt64
	if err := row.Scan(&b.ID, &b.OwnerID, &b.Username, &listed, &b.Add, &files, &b.CreatedAt, &setUp); err != nil {
		return nil, err
	}
	b.Listed = listed != 0
	b.Files = files != 0
	b.SetUp = setUp.Valid
	b.Channels = []string{}
	return &b, nil
}

// CreateBot makes a waiting bot and the one-use invite its program signs up with,
// unless its owner has `most` already or its username is taken.
func (d *DB) CreateBot(ctx context.Context, bot Bot, inviteCode string, expiresAt int64, most int) error {
	name := strings.ToLower(bot.Username)
	return d.tx(ctx, func(tx handle) error {
		var owned int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM bots WHERE owner_id = ? AND deleted_at IS NULL`, bot.OwnerID).Scan(&owned); err != nil {
			return err
		}
		if owned >= most {
			return ErrLimit
		}
		if taken, err := usernameTaken(ctx, tx, name, ""); err != nil {
			return err
		} else if taken {
			return ErrConflict
		}
		now := Now()
		if _, err := tx.ExecContext(ctx, `INSERT INTO invites(code, created_by, grants_role, max_uses, expires_at, created_at)
			VALUES(?, ?, 'bot', 1, ?, ?)`, inviteCode, bot.OwnerID, expiresAt, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO bots(id, owner_id, username, username_key, listed, add_policy, files, invite_code, created_at)
			VALUES(?,?,?,?,?,?,?,?,?)`, bot.ID, bot.OwnerID, bot.Username, name, bot.Listed, bot.Add, bot.Files, inviteCode, now)
		return err
	})
}

// usernameTaken says whether an account has a username, or a waiting bot other
// than `exceptBot` holds it.
func usernameTaken(ctx context.Context, tx handle, name, exceptBot string) (bool, error) {
	var users, waiting int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE username_key = ?`, name).Scan(&users); err != nil {
		return false, err
	}
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM bots WHERE username_key = ? AND set_up_at IS NULL AND id != ?`, name, exceptBot).Scan(&waiting); err != nil {
		return false, err
	}
	return users+waiting > 0, nil
}

// Bot returns a bot that hasn't been deleted, with the channels it was given.
func (d *DB) Bot(ctx context.Context, id string) (*Bot, error) {
	bot, err := scanBot(d.sql.QueryRowContext(ctx, `SELECT `+botColumns+` FROM bots WHERE id = ? AND deleted_at IS NULL`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	channels, err := collectStrings(ctx, d.sql, `SELECT channel_id FROM bot_channels WHERE bot_id = ? ORDER BY channel_id`, id)
	if err != nil {
		return nil, err
	}
	bot.Channels = append(bot.Channels, channels...)
	return bot, nil
}

// Bots lists someone's bots, waiting ones too, and with listedToo every listed
// bot on the server, as its admins see them.
func (d *DB) Bots(ctx context.Context, ownerID string, listedToo bool) ([]*Bot, error) {
	also := 0
	if listedToo {
		also = 1
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT `+botColumns+` FROM bots WHERE deleted_at IS NULL
		AND (owner_id = ?1 OR (?2 = 1 AND listed = 1 AND set_up_at IS NOT NULL)) ORDER BY created_at, id`, ownerID, also)
	if err != nil {
		return nil, err
	}
	bots := []*Bot{}
	byID := map[string]*Bot{}
	for rows.Next() {
		bot, err := scanBot(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		bots = append(bots, bot)
		byID[bot.ID] = bot
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(bots) == 0 {
		return bots, err
	}
	rows, err = d.sql.QueryContext(ctx, `SELECT bot_id, channel_id FROM bot_channels ORDER BY channel_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var botID, channelID string
		if err := rows.Scan(&botID, &channelID); err != nil {
			return nil, err
		}
		if bot := byID[botID]; bot != nil {
			bot.Channels = append(bot.Channels, channelID)
		}
	}
	return bots, rows.Err()
}

// UpdateBot changes what a bot may do. One made private is its owner's alone to
// add, and leaves the channels it was given, which it returns.
func (d *DB) UpdateBot(ctx context.Context, id string, listed *bool, add *string, files *bool) ([]string, error) {
	var left []string
	err := d.tx(ctx, func(tx handle) error {
		left = nil
		var nowListed, nowFiles int
		var nowAdd string
		err := tx.QueryRowContext(ctx, `SELECT listed, add_policy, files FROM bots WHERE id = ? AND deleted_at IS NULL`, id).Scan(&nowListed, &nowAdd, &nowFiles)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if listed != nil {
			nowListed = int(boolInt(*listed))
		}
		if add != nil {
			nowAdd = *add
		}
		if files != nil {
			nowFiles = int(boolInt(*files))
		}
		if nowListed == 0 {
			nowAdd = BotAddOwner
			if left, err = collectStrings(ctx, tx, `SELECT channel_id FROM bot_channels WHERE bot_id = ?`, id); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM bot_channels WHERE bot_id = ?`, id); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE bots SET listed = ?, add_policy = ?, files = ? WHERE id = ?`, nowListed, nowAdd, nowFiles, id); err != nil {
			return err
		}
		// Its account says some of this, to everyone who lists it.
		_, err = tx.ExecContext(ctx, `UPDATE users SET updated_at = ? WHERE id = ?`, Now(), id)
		return err
	})
	return left, err
}

// RenewBotSetup gives a waiting bot a new invite, and ends the one before.
func (d *DB) RenewBotSetup(ctx context.Context, id, inviteCode string, expiresAt int64) error {
	return d.tx(ctx, func(tx handle) error {
		var owner string
		var old sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT owner_id, invite_code FROM bots WHERE id = ? AND set_up_at IS NULL AND deleted_at IS NULL`, id).Scan(&owner, &old)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		now := Now()
		if _, err := tx.ExecContext(ctx, `UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL`, now, old.String); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO invites(code, created_by, grants_role, max_uses, expires_at, created_at)
			VALUES(?, ?, 'bot', 1, ?, ?)`, inviteCode, owner, expiresAt, now); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `UPDATE bots SET invite_code = ? WHERE id = ?`, inviteCode, id)
		return err
	})
}

// DeleteWaitingBot forgets a bot that never signed up, and ends its invite. One
// that has an account goes with it, through DeleteAccount.
func (d *DB) DeleteWaitingBot(ctx context.Context, id string) error {
	return d.tx(ctx, func(tx handle) error {
		var code sql.NullString
		err := tx.QueryRowContext(ctx, `SELECT invite_code FROM bots WHERE id = ? AND set_up_at IS NULL`, id).Scan(&code)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE invites SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL`, Now(), code.String); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM bots WHERE id = ?`, id)
		return err
	})
}

// SetBotChannels gives a listed bot exactly these channels, and returns the ones
// that took away. A private bot stays out of channels.
func (d *DB) SetBotChannels(ctx context.Context, id string, channels []string) ([]string, error) {
	var left []string
	err := d.tx(ctx, func(tx handle) error {
		left = nil
		var listed int
		err := tx.QueryRowContext(ctx, `SELECT listed FROM bots WHERE id = ? AND set_up_at IS NOT NULL AND deleted_at IS NULL`, id).Scan(&listed)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if listed == 0 {
			return ErrForbidden
		}
		current, err := collectStrings(ctx, tx, `SELECT channel_id FROM bot_channels WHERE bot_id = ?`, id)
		if err != nil {
			return err
		}
		for _, channel := range current {
			if slices.Contains(channels, channel) {
				continue
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM bot_channels WHERE bot_id = ? AND channel_id = ?`, id, channel); err != nil {
				return err
			}
			left = append(left, channel)
		}
		for _, channel := range uniqueStrings(channels...) {
			if slices.Contains(current, channel) {
				continue
			}
			var exists int
			if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM channels WHERE id = ?`, channel).Scan(&exists); err != nil {
				return err
			}
			if exists == 0 {
				return ErrNotFound
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO bot_channels(bot_id, channel_id) VALUES(?, ?)`, id, channel); err != nil {
				return err
			}
		}
		return nil
	})
	return left, err
}

// BotChannels lists the channels a bot was given.
func (d *DB) BotChannels(ctx context.Context, id string) ([]string, error) {
	return collectStrings(ctx, d.sql, `SELECT channel_id FROM bot_channels WHERE bot_id = ?`, id)
}

// BotRules returns what the server holds an account to if it's a bot's, or nil.
func (d *DB) BotRules(ctx context.Context, userID string) (*BotRules, error) {
	return botRules(ctx, d.sql, userID)
}

func botRules(ctx context.Context, q handle, userID string) (*BotRules, error) {
	var rules BotRules
	var listed, files int
	err := q.QueryRowContext(ctx, `SELECT owner_id, listed, add_policy, files FROM bots WHERE id = ? AND set_up_at IS NOT NULL`, userID).Scan(&rules.OwnerID, &listed, &rules.Add, &files)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rules.Listed = listed != 0
	rules.Files = files != 0
	return &rules, nil
}

// sharesChat is the condition that the account ?N is in a chat with the bot b.
const sharesChat = `EXISTS (SELECT 1 FROM group_members theirs JOIN group_members mine ON mine.group_id = theirs.group_id
	WHERE theirs.user_id = b.id AND mine.user_id = `

// CanSee says whether an account is there at all for someone. Every account is,
// but a private bot: that's there for its owner and for whoever is in a chat with it.
func (d *DB) CanSee(ctx context.Context, viewer, userID string) (bool, error) {
	return canSee(ctx, d.sql, viewer, userID)
}

func canSee(ctx context.Context, q handle, viewer, userID string) (bool, error) {
	var hidden int
	err := q.QueryRowContext(ctx, `SELECT COUNT(*) FROM bots b WHERE b.id = ?1 AND b.listed = 0 AND b.owner_id != ?2 AND b.id != ?2
		AND NOT `+sharesChat+`?2)`, userID, viewer).Scan(&hidden)
	return hidden == 0, err
}

// Audience is who hears about an account: everyone, or for a private bot its
// owner and whoever is in a chat with it, which it lists.
func (d *DB) Audience(ctx context.Context, userID string) (users []string, everyone bool, err error) {
	var owner string
	var listed int
	err = d.sql.QueryRowContext(ctx, `SELECT owner_id, listed FROM bots WHERE id = ?`, userID).Scan(&owner, &listed)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && listed != 0) {
		return nil, true, nil
	}
	if err != nil {
		return nil, false, err
	}
	users, err = collectStrings(ctx, d.sql, `SELECT DISTINCT other.user_id FROM group_members m
		JOIN group_members other ON other.group_id = m.group_id WHERE m.user_id = ?`, userID)
	if err != nil {
		return nil, false, err
	}
	return uniqueStrings(append(users, owner, userID)...), false, nil
}

// GroupPeople returns the members of a group who aren't bots.
func (d *DB) GroupPeople(ctx context.Context, groupID string) ([]string, error) {
	return collectStrings(ctx, d.sql, `SELECT m.user_id FROM group_members m WHERE m.group_id = ?
		AND NOT EXISTS (SELECT 1 FROM bots b WHERE b.id = m.user_id)`, groupID)
}

// mayClaim holds a bot's key packages to whoever may bring it into the chat
// they're for: the other person in a direct message with it, someone who may add
// it to that group, or a member of a group it's already in, for a new device of
// its. To anyone a private bot isn't there for, it doesn't exist.
func mayClaim(ctx context.Context, tx handle, botID, claimer, groupID string, serverAdmin bool) error {
	rules, err := botRules(ctx, tx, botID)
	if err != nil || rules == nil {
		return err
	}
	if seen, err := canSee(ctx, tx, claimer, botID); err != nil {
		return err
	} else if !seen {
		return ErrNotFound
	}
	var kind string
	var dmKey sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT g.kind, g.dm_key FROM groups g JOIN group_members m ON m.group_id = g.id
		WHERE g.id = ? AND m.user_id = ?`, groupID, claimer).Scan(&kind, &dmKey)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrForbidden
	}
	if err != nil {
		return err
	}
	switch kind {
	case "dm":
		if dmKey.String == DMKey(claimer, botID) {
			return nil
		}
	case "group":
		var in int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_members WHERE group_id = ? AND user_id = ?`, groupID, botID).Scan(&in); err != nil {
			return err
		}
		if in > 0 || rules.MayBeAddedBy(claimer, serverAdmin) {
			return nil
		}
	}
	return ErrForbidden
}
