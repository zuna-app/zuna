// Package emotes mirrors one 7TV emote set for a server.
//
// Each server's admins pick a single set. Clients load the images from their
// own server, which fetches and caches them, so 7TV never sees members' IP
// addresses and emotes keep working if 7TV is unreachable.
package emotes

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

	"zuna/server/internal/store"
)

// DefaultSet is used until an admin chooses a set: 7TV's global emotes.
const DefaultSet = "global"

const (
	maxImageBytes       = 8 << 20
	maxSetBytes         = 16 << 20
	userAgent           = "ZunaServer/1.0 (+self-hosted chat)"
	prefetchConcurrency = 6
)

var (
	// ErrInvalidSet means the given text doesn't identify a 7TV emote set.
	ErrInvalidSet = errors.New("not a valid 7TV emote set link or ID")
	// ErrSetNotFound means 7TV has no emote set with that ID.
	ErrSetNotFound = errors.New("7TV has no emote set with that ID")

	setIDPattern = regexp.MustCompile(`^[0-9A-Za-z]{10,40}$`)
	filePattern  = regexp.MustCompile(`^[1-4]x\.(webp|avif|gif|png)$`)
)

// Service fetches a set's metadata and caches its images on disk.
type Service struct {
	db      *store.DB
	dir     string
	client  *http.Client
	APIBase string
	CDNBase string

	// One download of each file at a time, however many ask for it at once.
	downloads singleflight.Group
}

func New(db *store.DB, dir string) *Service {
	return &Service{
		db:       db,
		dir:      dir,
		client:   &http.Client{Timeout: 30 * time.Second},
		APIBase:  "https://7tv.io/v3",
		CDNBase:  "https://cdn.7tv.app",
	}
}

// ParseSetID extracts a set ID from a 7TV link such as
// https://7tv.app/emote-sets/01ABC..., or from a bare ID.
func ParseSetID(input string) (string, error) {
	input = strings.TrimSpace(input)
	if input == DefaultSet {
		return input, nil
	}
	if i := strings.Index(input, "emote-sets/"); i >= 0 {
		input = input[i+len("emote-sets/"):]
		if j := strings.IndexAny(input, "/?#"); j >= 0 {
			input = input[:j]
		}
	}
	if !setIDPattern.MatchString(input) {
		return "", ErrInvalidSet
	}
	return input, nil
}

type setResponse struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Emotes []struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Flags int    `json:"flags"`
		Data  struct {
			Animated bool `json:"animated"`
			Flags    int  `json:"flags"`
			Owner    struct {
				Username    string `json:"username"`
				DisplayName string `json:"display_name"`
			} `json:"owner"`
			Host struct {
				Files []struct {
					Name   string `json:"name"`
					Width  int    `json:"width"`
					Height int    `json:"height"`
				} `json:"files"`
			} `json:"host"`
		} `json:"data"`
	} `json:"emotes"`
}

// Sync downloads the named set and makes it this server's current set.
// It returns the set's name and how many emotes it contains.
func (s *Service) Sync(ctx context.Context, setID string) (string, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.APIBase+"/emote-sets/"+setID, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := s.client.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("contacting 7TV: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusBadRequest {
		return "", 0, ErrSetNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("7TV responded with status %d", resp.StatusCode)
	}
	var set setResponse
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxSetBytes)).Decode(&set); err != nil {
		return "", 0, fmt.Errorf("reading 7TV response: %w", err)
	}

	emotes := make([]store.Emote, 0, len(set.Emotes))
	for _, e := range set.Emotes {
		if !setIDPattern.MatchString(e.ID) || e.Name == "" {
			continue
		}
		emote := store.Emote{
			ID:       e.ID,
			Name:     e.Name,
			Animated: e.Data.Animated,
			// Zero-width emotes stack on top of the previous emote. 7TV marks
			// them on the set entry (bit 0) or on the emote itself (bit 8).
			ZeroWidth: e.Flags&1 != 0 || e.Data.Flags&256 != 0,
			Owner:     e.Data.Owner.DisplayName,
		}
		if emote.Owner == "" {
			emote.Owner = e.Data.Owner.Username
		}
		for _, file := range e.Data.Host.Files {
			if file.Name == "1x.webp" {
				emote.Width, emote.Height = file.Width, file.Height
			}
		}
		emotes = append(emotes, emote)
	}
	if err := s.db.ReplaceEmoteSet(ctx, emotes); err != nil {
		return "", 0, err
	}
	if err := s.db.SetSetting(ctx, "emote_set_id", setID); err != nil {
		return "", 0, err
	}
	if err := s.db.SetSetting(ctx, "emote_set_name", set.Name); err != nil {
		return "", 0, err
	}
	go s.prefetch(emotes)
	return set.Name, len(emotes), nil
}

// prefetch downloads a set's images ahead of time, so the first person to open
// the emote picker sees them straight away. Failures are retried on demand.
func (s *Service) prefetch(emotes []store.Emote) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	slots := make(chan struct{}, prefetchConcurrency)
	var wg sync.WaitGroup
	for _, emote := range emotes {
		for _, file := range []string{"1x.webp", "2x.webp"} {
			path := filepath.Join(s.dir, emote.ID, file)
			if _, err := os.Stat(path); err == nil {
				continue
			}
			wg.Add(1)
			slots <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-slots }()
				_ = s.fetch(ctx, emote.ID, file, path)
			}()
		}
	}
	wg.Wait()
}

// RefreshCurrent re-syncs the configured set, picking up changes on 7TV.
func (s *Service) RefreshCurrent(ctx context.Context) error {
	setID, err := s.db.Setting(ctx, "emote_set_id", DefaultSet)
	if err != nil {
		return err
	}
	_, _, err = s.Sync(ctx, setID)
	return err
}


// ServeImage serves one emote image, downloading it on first use.
func (s *Service) ServeImage(w http.ResponseWriter, r *http.Request, id, file string) {
	if !setIDPattern.MatchString(id) || !filePattern.MatchString(file) {
		http.NotFound(w, r)
		return
	}
	known, err := s.db.EmoteKnown(r.Context(), id)
	if err != nil || !known {
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(s.dir, id, file)
	if err := s.fetch(r.Context(), id, file, path); err != nil {
		http.Error(w, "emote unavailable", http.StatusBadGateway)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	http.ServeFile(w, r, path)
}

// fetch downloads an emote's file unless it's here, once however many ask for it at once.
func (s *Service) fetch(ctx context.Context, id, file, path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	_, err, _ := s.downloads.Do(id+"/"+file, func() (any, error) {
		if _, err := os.Stat(path); err == nil {
			return nil, nil
		}
		return nil, s.download(ctx, id, file, path)
	})
	return err
}

func (s *Service) download(ctx context.Context, id, file, path string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.CDNBase+"/emote/"+id+"/"+file, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("7TV CDN responded with status %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "download-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, io.LimitReader(resp.Body, maxImageBytes)); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
