package api

import (
	"context"
	"log/slog"
	"os"
	"strconv"
	"time"

	"zuna/server/internal/ratelimit"
	"zuna/server/internal/store"
)

// background runs a loop of RunBackground's, counted for Wait.
func (s *Server) background(loop func()) {
	if !s.track() {
		return
	}
	go func() {
		defer s.work.Done()
		loop()
	}()
}

func (s *Server) RunBackground(ctx context.Context) {
	s.background(func() {
		// Keep trying until the first load succeeds, then refresh occasionally.
		// Clients connected in the meantime are told, so they aren't left without emotes.
		wait := time.Duration(0)
		loaded := false
		for {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			changed, err := s.emotes.RefreshCurrent(ctx)
			if err != nil {
				slog.Warn("couldn't load the 7TV emote set; it will be retried", "error", err)
				wait = emoteRetry
				continue
			}
			// Every device fetches the set again when told, so only the first load and a set
			// that changed are worth telling them about.
			if !loaded || changed {
				s.hub.ToAll(Event{Type: "emotes"})
			}
			loaded = true
			wait = emoteRefresh
		}
	})
	s.background(func() {
		ticker := time.NewTicker(cleanupInterval)
		defer ticker.Stop()
		for {
			s.cleanup(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
	s.background(func() {
		ticker := time.NewTicker(expiryInterval)
		defer ticker.Stop()
		for {
			s.removeExpired(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	})
}

// removeExpired removes the disappearing messages that are due, and their files.
func (s *Server) removeExpired(ctx context.Context) {
	files, err := s.db.DeleteExpiredMessages(ctx, store.Now())
	if err != nil {
		slog.Warn("removing disappearing messages", "error", err)
	}
	s.removeFiles(ctx, files)
}

func (s *Server) cleanup(ctx context.Context) {
	cutoff := time.Now().Add(-unattachedTTL).UnixMilli()
	unattached, err := s.db.UnattachedFiles(ctx, cutoff)
	if err != nil {
		slog.Warn("listing unattached files", "error", err)
	}
	s.removeFiles(ctx, unattached)
	abandoned, err := s.db.AbandonedUploads(ctx, time.Now().Add(-abandonedUploadTTL).UnixMilli())
	if err != nil {
		slog.Warn("listing abandoned uploads", "error", err)
	}
	s.removeFiles(ctx, abandoned)
	if err := s.db.DeleteExpiredSessions(ctx); err != nil {
		slog.Warn("removing expired sessions", "error", err)
	}
	if err := s.db.DeleteSignInAttemptsBefore(ctx, time.Now().Add(-ratelimit.ForgetAfter).UnixMilli()); err != nil {
		slog.Warn("forgetting old sign-in attempts", "error", err)
	}
	if err := s.db.PruneTokens(ctx); err != nil {
		slog.Warn("forgetting old token keys", "error", err)
	}
	defer func() {
		if err := s.db.PruneCommits(ctx); err != nil {
			slog.Warn("removing old commits", "error", err)
		}
		if err := s.db.RecountStorage(ctx); err != nil {
			slog.Warn("recounting storage", "error", err)
		}
	}()

	days, err := s.intSetting(ctx, "retention_days", 0)
	// Anything larger may have been stored before there was a limit. Going back that
	// far wraps around to a date in the future, before which everything is older.
	if err != nil || days <= 0 || days > maxRetentionDays {
		return
	}
	expired := time.Now().AddDate(0, 0, -days).UnixMilli()
	files, err := s.db.DeleteMessagesOlderThan(ctx, expired)
	if err != nil {
		slog.Warn("applying message retention", "error", err)
	}
	s.removeFiles(ctx, files)
}

func (s *Server) removeFiles(ctx context.Context, ids []string) {
	for _, id := range ids {
		if !store.ValidID(id) {
			continue
		}
		if err := os.RemoveAll(s.fileDir(id)); err != nil {
			slog.Warn("removing file", "id", id, "error", err)
			continue
		}
		if err := s.db.DeleteFile(ctx, id); err != nil {
			slog.Warn("removing file record", "id", id, "error", err)
		}
	}
}

func (s *Server) intSetting(ctx context.Context, key string, fallback int) (int, error) {
	raw, err := s.db.Setting(ctx, key, strconv.Itoa(fallback))
	if err != nil {
		return fallback, err
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback, nil
	}
	return value, nil
}
