package store

import "context"

// Emote is one 7TV emote known to this server.
type Emote struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Animated  bool   `json:"animated"`
	ZeroWidth bool   `json:"zero_width"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	// Owner is the display name of whoever created the emote on 7TV.
	Owner string `json:"owner"`
}

// ReplaceEmoteSet makes emotes the current set. Emotes previously known stay
// in the table so old messages using them keep rendering.
// ReplaceEmoteSet makes these the server's emotes, and the set's ID and name its
// settings, all at once, and says whether any of it differs from what was there.
func (d *DB) ReplaceEmoteSet(ctx context.Context, emotes []Emote, setID, setName string) (bool, error) {
	before, err := d.EmoteSet(ctx)
	if err != nil {
		return false, err
	}
	oldID, err := d.Setting(ctx, "emote_set_id", "")
	if err != nil {
		return false, err
	}
	oldName, err := d.Setting(ctx, "emote_set_name", "")
	if err != nil {
		return false, err
	}
	changed := oldID != setID || oldName != setName || !sameEmotes(before, emotes)
	return changed, d.tx(ctx, func(tx handle) error {
		if _, err := tx.ExecContext(ctx, `UPDATE emotes SET in_set = 0`); err != nil {
			return err
		}
		for key, value := range map[string]string{"emote_set_id": setID, "emote_set_name": setName} {
			if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES(?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
				return err
			}
		}
		for _, e := range emotes {
			if _, err := tx.ExecContext(ctx, `INSERT INTO emotes(id, name, animated, zero_width, width, height, owner, in_set)
				VALUES(?,?,?,?,?,?,?,1)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name, animated = excluded.animated,
				zero_width = excluded.zero_width, width = excluded.width, height = excluded.height,
				owner = excluded.owner, in_set = 1`,
				e.ID, e.Name, e.Animated, e.ZeroWidth, e.Width, e.Height, e.Owner); err != nil {
				return err
			}
		}
		return nil
	})
}

// sameEmotes says whether two sets hold the same emotes, however they're ordered.
func sameEmotes(a, b []Emote) bool {
	if len(a) != len(b) {
		return false
	}
	byID := make(map[string]Emote, len(a))
	for _, e := range a {
		byID[e.ID] = e
	}
	for _, e := range b {
		if byID[e.ID] != e {
			return false
		}
	}
	return true
}

func (d *DB) EmoteSet(ctx context.Context) ([]Emote, error) {
	rows, err := d.sql.QueryContext(ctx, `SELECT id, name, animated, zero_width, width, height, owner FROM emotes WHERE in_set = 1 ORDER BY LOWER(name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	emotes := []Emote{}
	for rows.Next() {
		var e Emote
		if err := rows.Scan(&e.ID, &e.Name, &e.Animated, &e.ZeroWidth, &e.Width, &e.Height, &e.Owner); err != nil {
			return nil, err
		}
		emotes = append(emotes, e)
	}
	return emotes, rows.Err()
}

func (d *DB) EmoteKnown(ctx context.Context, id string) (bool, error) {
	var n int
	err := d.sql.QueryRowContext(ctx, `SELECT COUNT(*) FROM emotes WHERE id = ?`, id).Scan(&n)
	return n > 0, err
}
