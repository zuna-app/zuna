package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strconv"

	"zuna/server/internal/hybrid"
	"zuna/server/internal/merkle"
)

// --- The log of keys ---
//
// Every change to who holds which keys appends an entry here, in the transaction
// that makes the change: an account made, a device added or removed, a certificate
// or seal key replaced, a new generation, an account deleted. Entries are hashed into
// a Merkle tree, whose head the server signs. Everyone gets every record, which says
// nothing by itself, and an entry's body only if its account is there for them.
// docs/KEY_TRANSPARENCY_PLAN.md has the design.

const (
	settingLogKey      = "log_key"
	settingLogEra      = "log_era"
	settingLogSize     = "log_size"
	settingLogFrontier = "log_frontier"
)

// The most of the log one answer gives.
const MaxLogPage = 5000

// LogEntry is one place in the log: its record, and its body for whoever gets it.
type LogEntry struct {
	Idx    int64  `json:"idx"`
	Record []byte `json:"record"`
	Body   []byte `json:"body,omitempty"`
	UserID string `json:"-"`
}

// LogHead is the log at some size, signed with its key.
type LogHead struct {
	Era  int64  `json:"era"`
	Size int64  `json:"size"`
	Root []byte `json:"root"`
	Sig  []byte `json:"sig"`
}

// LogPage is a stretch of the log after some place, and the head where it ends.
type LogPage struct {
	Era     int64      `json:"era"`
	Size    int64      `json:"size"`
	Head    LogHead    `json:"head"`
	Entries []LogEntry `json:"records"`
}

type logState struct {
	era      int64
	frontier merkle.Frontier
}

// The bodies of entries, as JSON in this order. Hashes and keys are base64, as Go
// writes bytes. A body names nothing of when.
type accountBody struct {
	V        int    `json:"v"`
	T        string `json:"t"`
	User     string `json:"user"`
	Username string `json:"username"`
	Root     []byte `json:"root"`
	Hpke     []byte `json:"hpke"`
	HpkeSig  []byte `json:"hpke_sig"`
}

type deviceBody struct {
	V      int    `json:"v"`
	T      string `json:"t"`
	User   string `json:"user"`
	Device string `json:"device"`
	Key    []byte `json:"key"`
	Cert   []byte `json:"cert"`
	Enroll []byte `json:"enroll"`
	Seal   []byte `json:"seal"`
}

type certificateBody struct {
	V      int    `json:"v"`
	T      string `json:"t"`
	User   string `json:"user"`
	Device string `json:"device"`
	Cert   []byte `json:"cert"`
}

type sealBody struct {
	V      int    `json:"v"`
	T      string `json:"t"`
	User   string `json:"user"`
	Device string `json:"device"`
	Gen    int64  `json:"gen"`
	Seal   []byte `json:"seal"`
}

type revokedBody struct {
	V      int    `json:"v"`
	T      string `json:"t"`
	User   string `json:"user"`
	Device string `json:"device"`
}

type linkBody struct {
	V    int    `json:"v"`
	T    string `json:"t"`
	User string `json:"user"`
	Gen  int64  `json:"gen"`
	Link []byte `json:"link"`
}

type deletedBody struct {
	V    int    `json:"v"`
	T    string `json:"t"`
	User string `json:"user"`
}

func sha(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

// sealHash is what an entry holds of a device's seal key: the key, its generation and the device's proof of the two.
func sealHash(key []byte, generation int64, proof []byte) []byte {
	data := append([]byte{}, key...)
	data = binary.BigEndian.AppendUint64(data, uint64(generation))
	return sha(append(data, proof...))
}

func accountEntry(userID, username string, root, hpke, hpkeSig []byte) accountBody {
	return accountBody{1, "account", userID, username, root, hpke, hpkeSig}
}

func deviceEntry(dev Device) deviceBody {
	var generation int64
	if dev.SealGeneration != nil {
		generation = *dev.SealGeneration
	}
	return deviceBody{1, "device", dev.UserID, dev.ID, dev.SignatureKey, sha(dev.Certificate), sha(dev.EnrollProof), sealHash(dev.SealKey, generation, dev.SealProof)}
}

func revokedEntry(userID, deviceID string) revokedBody {
	return revokedBody{1, "revoked", userID, deviceID}
}

func linkEntry(userID string, generation int64, payload []byte) linkBody {
	return linkBody{1, "link", userID, generation, sha(payload)}
}

func randomBytes(n int) []byte {
	out := make([]byte, n)
	if _, err := rand.Read(out); err != nil {
		panic(err)
	}
	return out
}

func readLogState(ctx context.Context, q handle) (logState, error) {
	rows, err := q.QueryContext(ctx, `SELECT key, value FROM settings WHERE key IN (?, ?, ?)`, settingLogEra, settingLogSize, settingLogFrontier)
	if err != nil {
		return logState{}, err
	}
	defer rows.Close()
	values := map[string]string{}
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return logState{}, err
		}
		values[key] = value
	}
	if err := rows.Err(); err != nil {
		return logState{}, err
	}
	era, err1 := strconv.ParseInt(values[settingLogEra], 10, 64)
	size, err2 := strconv.ParseUint(values[settingLogSize], 10, 64)
	roots, err3 := base64.StdEncoding.DecodeString(values[settingLogFrontier])
	if err := errors.Join(err1, err2, err3); err != nil {
		return logState{}, errors.New("the log of keys isn't set up")
	}
	frontier, err := merkle.ParseFrontier(size, roots)
	return logState{era: era, frontier: frontier}, err
}

func writeLogState(ctx context.Context, tx handle, state logState) error {
	for key, value := range map[string]string{
		settingLogEra:      strconv.FormatInt(state.era, 10),
		settingLogSize:     strconv.FormatUint(state.frontier.Size, 10),
		settingLogFrontier: base64.StdEncoding.EncodeToString(state.frontier.Bytes()),
	} {
		if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES(?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value); err != nil {
			return err
		}
	}
	return nil
}

// appendLog adds an entry about an account, inside the transaction that makes the
// change it's about, so that one is never kept without the other.
func appendLog(ctx context.Context, tx handle, userID string, body any) error {
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	state, err := readLogState(ctx, tx)
	if err != nil {
		return err
	}
	nonce := randomBytes(merkle.NonceSize)
	// Only an account's first entry names its username, and nobody can tell which those are.
	nameTag := randomBytes(merkle.TagSize)
	if account, ok := body.(accountBody); ok {
		nameTag = merkle.NameTag(account.Username, nonce)
	}
	record := merkle.Record(nonce, merkle.UserTag(userID, nonce), nameTag, merkle.BodyHash(nonce, data))
	idx := state.frontier.Size
	state.frontier.Append(merkle.Leaf(record))
	root := state.frontier.Root()
	if _, err := tx.ExecContext(ctx, `INSERT INTO log_entries(era, idx, record, body, user_id, root) VALUES(?, ?, ?, ?, ?, ?)`,
		state.era, int64(idx), record, data, userID, root[:]); err != nil {
		return err
	}
	if err := writeLogState(ctx, tx, state); err != nil {
		return err
	}
	if tx.logged != nil {
		*tx.logged = true
	}
	return nil
}

// ensureLog makes the log's key, and starts its first era with nothing in it, on a
// database that has neither yet.
func (d *DB) ensureLog(ctx context.Context) error {
	return d.tx(ctx, func(tx handle) error {
		var held int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM settings WHERE key = ?`, settingLogKey).Scan(&held); err != nil {
			return err
		}
		if held > 0 {
			return nil
		}
		seed := randomBytes(hybrid.SeedSize)
		if _, err := tx.ExecContext(ctx, `INSERT INTO settings(key, value) VALUES(?, ?)`, settingLogKey, base64.StdEncoding.EncodeToString(seed)); err != nil {
			return err
		}
		return writeLogState(ctx, tx, logState{era: 1})
	})
}

// LogKey is the key the log's heads are signed with, which never changes: a lasting
// hybrid key, Ed25519 and ML-DSA-65, from the seed the database keeps.
func (d *DB) LogKey(ctx context.Context) (*hybrid.Key, error) {
	d.logKeyMu.Lock()
	defer d.logKeyMu.Unlock()
	if d.logKey != nil {
		return d.logKey, nil
	}
	encoded, err := d.Setting(ctx, settingLogKey, "")
	if err != nil {
		return nil, err
	}
	seed, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(seed) != hybrid.SeedSize {
		return nil, errors.New("the log of keys has no key")
	}
	key, err := hybrid.NewKey(append([]byte{hybrid.Lasting}, seed...))
	if err != nil {
		return nil, err
	}
	d.logKey = key
	return d.logKey, nil
}

// LogPublicKey is what devices check the log's heads with.
func (d *DB) LogPublicKey(ctx context.Context) ([]byte, error) {
	key, err := d.LogKey(ctx)
	if err != nil {
		return nil, err
	}
	return key.Public(), nil
}

func (d *DB) signHead(ctx context.Context, era, size int64, root merkle.Hash) (LogHead, error) {
	key, err := d.LogKey(ctx)
	if err != nil {
		return LogHead{}, err
	}
	sig, err := key.Sign(merkle.HeadInput(uint64(era), uint64(size), root))
	if err != nil {
		return LogHead{}, err
	}
	return LogHead{Era: era, Size: size, Root: root[:], Sig: sig}, nil
}

// LogStatus is the log's era and size now, which tells a device whether it has all of it.
func (d *DB) LogStatus(ctx context.Context) (era, size int64, err error) {
	state, err := readLogState(ctx, d.sql)
	return state.era, int64(state.frontier.Size), err
}

// hiddenFrom is the accounts whose entries' bodies someone doesn't get: the private
// bots that aren't there for them, as canSee has it.
func (d *DB) hiddenFrom(ctx context.Context, viewer string) (map[string]bool, error) {
	ids, err := collectStrings(ctx, d.sql, `SELECT b.id FROM bots b WHERE b.listed = 0 AND b.owner_id != ?1 AND b.id != ?1
		AND NOT `+sharesChat+`?1)`, viewer)
	hidden := map[string]bool{}
	for _, id := range ids {
		hidden[id] = true
	}
	return hidden, err
}

// Log is the records after a place in the current era, each with its body if its
// account is there for `viewer`, and the signed head where they end. A viewer with no
// device gets only their own account's bodies. Asked about another era, it starts
// from the beginning of this one.
func (d *DB) Log(ctx context.Context, viewer string, withDevice bool, era, after int64, limit int) (*LogPage, error) {
	state, err := readLogState(ctx, d.sql)
	if err != nil {
		return nil, err
	}
	size := int64(state.frontier.Size)
	if era != state.era || after < 0 {
		after = 0
	}
	page := &LogPage{Era: state.era, Size: size, Entries: []LogEntry{}}
	if after >= size {
		// Nothing after it, or it's past the end, which the device takes for the server going back.
		page.Head, err = d.signHead(ctx, state.era, size, state.frontier.Root())
		return page, err
	}
	hidden := map[string]bool{}
	if withDevice {
		if hidden, err = d.hiddenFrom(ctx, viewer); err != nil {
			return nil, err
		}
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT idx, record, body, user_id, root FROM log_entries WHERE era = ? AND idx >= ? AND idx < ? ORDER BY idx LIMIT ?`,
		state.era, after, size, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var root []byte
	for rows.Next() {
		var entry LogEntry
		if err := rows.Scan(&entry.Idx, &entry.Record, &entry.Body, &entry.UserID, &root); err != nil {
			return nil, err
		}
		if (withDevice && hidden[entry.UserID]) || (!withDevice && entry.UserID != viewer) {
			entry.Body = nil
		}
		page.Entries = append(page.Entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	end := after + int64(len(page.Entries))
	if len(page.Entries) == 0 || page.Entries[len(page.Entries)-1].Idx != end-1 || len(root) != merkle.HashSize {
		return nil, errors.New("the log of keys has a gap")
	}
	page.Head, err = d.signHead(ctx, state.era, end, merkle.Hash(root))
	return page, err
}

// LogBodies is every body of one account's entries in the current era, for someone
// it has only now become there for.
func (d *DB) LogBodies(ctx context.Context, userID string) (int64, []LogEntry, error) {
	state, err := readLogState(ctx, d.sql)
	if err != nil {
		return 0, nil, err
	}
	rows, err := d.sql.QueryContext(ctx, `SELECT idx, body FROM log_entries WHERE era = ? AND user_id = ? ORDER BY idx`, state.era, userID)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	entries := []LogEntry{}
	for rows.Next() {
		var entry LogEntry
		if err := rows.Scan(&entry.Idx, &entry.Body); err != nil {
			return 0, nil, err
		}
		entries = append(entries, entry)
	}
	return state.era, entries, rows.Err()
}

// StartLogEra starts the log again, under its next era and the same key, written
// from what the tables hold now. It's for a server restored from a backup, whose log
// is shorter than what its members' devices have seen.
func (d *DB) StartLogEra(ctx context.Context) (int64, error) {
	var era int64
	err := d.tx(ctx, func(tx handle) error {
		state, err := readLogState(ctx, tx)
		if err != nil {
			return err
		}
		era = state.era + 1
		if _, err := tx.ExecContext(ctx, `DELETE FROM log_entries`); err != nil {
			return err
		}
		if err := writeLogState(ctx, tx, logState{era: era}); err != nil {
			return err
		}
		return rewriteLog(ctx, tx)
	})
	return era, err
}

// rewriteLog writes an entry for everything the tables say about each account's keys:
// the account, its devices as they are now, its links, the devices that are gone, and
// whether it was deleted.
func rewriteLog(ctx context.Context, tx handle) error {
	type account struct {
		id, username      string
		root, hpke, sig   []byte
		deleted           bool
		devices           []Device
		links             []linkBody
	}
	var accounts []*account
	byID := map[string]*account{}
	rows, err := tx.QueryContext(ctx, `SELECT id, username, identity_key, hpke_key, hpke_key_sig, deleted_at FROM users ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var a account
		var deleted sql.NullInt64
		if err := rows.Scan(&a.id, &a.username, &a.root, &a.hpke, &a.sig, &deleted); err != nil {
			rows.Close()
			return err
		}
		a.deleted = deleted.Valid
		accounts = append(accounts, &a)
		byID[a.id] = &a
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	devices, err := tx.QueryContext(ctx, `SELECT `+deviceColumns+` FROM devices ORDER BY created_at, id`)
	if err != nil {
		return err
	}
	for devices.Next() {
		dev, err := scanDevice(devices)
		if err != nil {
			devices.Close()
			return err
		}
		if a := byID[dev.UserID]; a != nil {
			a.devices = append(a.devices, dev)
		}
	}
	devices.Close()
	if err := devices.Err(); err != nil {
		return err
	}
	links, err := tx.QueryContext(ctx, `SELECT user_id, generation, payload FROM identity_links ORDER BY user_id, generation`)
	if err != nil {
		return err
	}
	for links.Next() {
		var userID string
		var generation int64
		var payload []byte
		if err := links.Scan(&userID, &generation, &payload); err != nil {
			links.Close()
			return err
		}
		if a := byID[userID]; a != nil {
			a.links = append(a.links, linkEntry(userID, generation, payload))
		}
	}
	links.Close()
	if err := links.Err(); err != nil {
		return err
	}
	for _, a := range accounts {
		bodies := []any{accountEntry(a.id, a.username, a.root, a.hpke, a.sig)}
		for _, dev := range a.devices {
			bodies = append(bodies, deviceEntry(dev))
		}
		for _, link := range a.links {
			bodies = append(bodies, link)
		}
		for _, dev := range a.devices {
			if dev.RevokedAt != nil {
				bodies = append(bodies, revokedEntry(a.id, dev.ID))
			}
		}
		if a.deleted {
			bodies = append(bodies, deletedBody{1, "deleted", a.id})
		}
		for _, body := range bodies {
			if err := appendLog(ctx, tx, a.id, body); err != nil {
				return err
			}
		}
	}
	return nil
}

// OnLog has fn called whenever a change to the log of keys is kept.
func (d *DB) OnLog(fn func()) { d.onLog = fn }
