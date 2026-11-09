package api

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strconv"
	"time"

	"zuna/server/internal/store"
)

const (
	// How long a bot's setup link works, for the one use it has.
	botSetupLife = time.Hour
	// How many bots one person may have, if the server doesn't say otherwise.
	defaultMaxBots = 5
	maxMaxBots     = 1000
)

// --- Who hears about an account ---

// hearers is who's told about an account: everyone, or for a private bot its owner
// and whoever is in a chat with it. It's worked out before anything takes a bot out
// of its chats, so that the people in them hear that it went.
type hearers struct {
	users    []string
	everyone bool
}

func (s *Server) hearersOf(ctx context.Context, userID string) hearers {
	users, everyone, err := s.db.Audience(ctx, userID)
	if err != nil {
		// Nobody, rather than everyone: a private bot is told of to nobody by mistake.
		return hearers{}
	}
	return hearers{users: users, everyone: everyone}
}

// tell sends an account as it is now to whoever hears about it.
func (s *Server) tell(ctx context.Context, userID string, to hearers) {
	user, err := s.db.User(ctx, userID)
	if err != nil {
		return
	}
	s.hub.ToUsers([]string{userID}, Event{Type: "user", Data: user})
	others := Event{Type: "user", Data: seenByOthers(user)}
	if to.everyone {
		s.hub.ToAllExcept(userID, others)
	} else {
		s.hub.ToUsers(slices.DeleteFunc(slices.Clone(to.users), func(id string) bool { return id == userID }), others)
	}
	// What shows a bot's key to be the one its setup link made is for its owner's app.
	if user.Bot != nil && len(user.Bot.Proof) > 0 {
		s.hub.ToUsers([]string{user.Bot.OwnerID}, Event{Type: "user", Data: seenFor(user, user.Bot.OwnerID)})
	}
}

// canSee says whether an account is there for the caller, and writes the refusal
// if it isn't: a private bot doesn't exist for anyone it shares no chat with.
func (s *Server) canSee(w http.ResponseWriter, r *http.Request, sess *store.Session, userID string) bool {
	seen, err := s.db.CanSee(r.Context(), sess.UserID, userID)
	if err != nil {
		writeFailure(w, err)
		return false
	}
	if !seen {
		writeFailure(w, store.ErrNotFound)
	}
	return seen
}

// refuseBot writes the refusal for something no bot may do, and says whether it did.
func refuseBot(w http.ResponseWriter, sess *store.Session) bool {
	if sess.Bot {
		writeError(w, http.StatusForbidden, "bot", "A bot can't do this.")
	}
	return sess.Bot
}

// --- Bots ---

// handleBots lists the caller's bots, and for the server's admins every listed one.
func (s *Server) handleBots(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	bots, err := s.db.Bots(r.Context(), sess.UserID, isServerAdmin(sess))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bots": bots})
}

// mayMakeBot says whether someone may have a bot of a kind: a listed one is for the
// server's admins to make, and a private one for them and, if the server says so,
// for everyone.
func (s *Server) mayMakeBot(r *http.Request, sess *store.Session, listed bool) (bool, error) {
	if isServerAdmin(sess) {
		return true, nil
	}
	if listed {
		return false, nil
	}
	allowed, err := s.db.Setting(r.Context(), "allow_member_bots", "false")
	return allowed == "true", err
}

// handleCreateBot makes a bot that's waiting, and the invite its program signs up
// with, once, within the hour. The rest of its setup link never reaches the server.
func (s *Server) handleCreateBot(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	if refuseBot(w, sess) {
		return
	}
	var body struct {
		Username string `json:"username"`
		Listed   bool   `json:"listed"`
		Add      string `json:"add"`
		// Left out, it may send files.
		Files *bool `json:"files"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !usernamePattern.MatchString(body.Username) {
		writeError(w, http.StatusBadRequest, "invalid_username",
			"Usernames are 2-32 characters: letters, numbers, dots, dashes and underscores.")
		return
	}
	if body.Add == "" || !body.Listed {
		body.Add = store.BotAddOwner
	}
	if !store.ValidBotAdd(body.Add) {
		writeError(w, http.StatusBadRequest, "bad_request", "Those bot settings aren't valid.")
		return
	}
	allowed, err := s.mayMakeBot(r, sess, body.Listed)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeError(w, http.StatusForbidden, "forbidden", "This server doesn't let you make that kind of bot.")
		return
	}
	most, err := s.intSetting(r.Context(), "max_bots", defaultMaxBots)
	if err != nil {
		writeFailure(w, err)
		return
	}
	bot := store.Bot{
		ID:       store.NewID(),
		OwnerID:  sess.UserID,
		Username: body.Username,
		Listed:   body.Listed,
		Add:      body.Add,
		Files:    body.Files == nil || *body.Files,
	}
	code := randomToken(18)
	err = s.db.CreateBot(r.Context(), bot, code, store.Now()+botSetupLife.Milliseconds(), most)
	if errors.Is(err, store.ErrLimit) {
		writeError(w, http.StatusForbidden, "too_many_bots", "You have as many bots as this server lets one person have.")
		return
	}
	if errors.Is(err, store.ErrConflict) {
		writeError(w, http.StatusConflict, "username_taken", "That username is already taken.")
		return
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	created, err := s.db.Bot(r.Context(), bot.ID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"bot": created, "code": code})
}

// ownedBot is the bot a request is about, if it's the caller's.
func (s *Server) ownedBot(w http.ResponseWriter, r *http.Request, sess *store.Session) *store.Bot {
	bot, err := s.db.Bot(r.Context(), r.PathValue("id"))
	// Someone else's private bot doesn't exist, as far as anyone else is told.
	if err == nil && bot.OwnerID != sess.UserID {
		err = store.ErrNotFound
	}
	if err != nil {
		writeFailure(w, err)
		return nil
	}
	return bot
}

// handleUpdateBot changes what a bot may do, which is its owner's to say.
func (s *Server) handleUpdateBot(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	bot := s.ownedBot(w, r, sess)
	if bot == nil {
		return
	}
	var body struct {
		Listed *bool   `json:"listed"`
		Add    *string `json:"add"`
		Files  *bool   `json:"files"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Add != nil && !store.ValidBotAdd(*body.Add) {
		writeError(w, http.StatusBadRequest, "bad_request", "Those bot settings aren't valid.")
		return
	}
	if body.Listed != nil && *body.Listed && !bot.Listed && !isServerAdmin(sess) {
		writeError(w, http.StatusForbidden, "forbidden", "Only server admins can list a bot for everyone.")
		return
	}
	ctx := r.Context()
	// Who heard of it before, and who does now: one made private goes on being
	// there for whoever knew it, and one listed is news to everyone.
	before := s.hearersOf(ctx, bot.ID)
	left, err := s.db.UpdateBot(ctx, bot.ID, body.Listed, body.Add, body.Files)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if bot.SetUp {
		for _, channelID := range left {
			if err := s.removeFromRoster(r, channelID, sess.UserID, bot.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
				writeFailure(w, err)
				return
			}
		}
		after := s.hearersOf(ctx, bot.ID)
		if !after.everyone {
			after.users = append(after.users, before.users...)
		}
		s.tell(ctx, bot.ID, after)
		if len(left) > 0 {
			s.hub.ToUsers([]string{bot.ID}, Event{Type: "channels"})
		}
	}
	updated, err := s.db.Bot(ctx, bot.ID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bot": updated})
}

// handleBotSetup gives a bot that hasn't signed up yet a new invite, for a setup
// link that ran out or was lost. The one before stops working.
func (s *Server) handleBotSetup(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	bot := s.ownedBot(w, r, sess)
	if bot == nil {
		return
	}
	if bot.SetUp {
		writeError(w, http.StatusConflict, "conflict", "This bot is set up already.")
		return
	}
	code := randomToken(18)
	if err := s.db.RenewBotSetup(r.Context(), bot.ID, code, store.Now()+botSetupLife.Milliseconds()); err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bot": bot, "code": code})
}

// handleDeleteBot deletes a bot for good: its owner's to do, and for a listed one
// any server admin's.
func (s *Server) handleDeleteBot(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	bot, err := s.db.Bot(r.Context(), r.PathValue("id"))
	if err == nil && bot.OwnerID != sess.UserID && !(bot.Listed && bot.SetUp && isServerAdmin(sess)) {
		err = store.ErrNotFound
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	if err := s.deleteBot(r, bot); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

// deleteBot takes a bot away for good: one that's waiting is forgotten, and one
// with an account loses it, as a person deleting theirs does.
func (s *Server) deleteBot(r *http.Request, bot *store.Bot) error {
	if !bot.SetUp {
		return s.db.DeleteWaitingBot(r.Context(), bot.ID)
	}
	return s.eraseAccount(r, bot.ID, "")
}

// deleteBotsOf takes someone's bots with them, as their account is banned or deleted.
func (s *Server) deleteBotsOf(r *http.Request, ownerID string) error {
	bots, err := s.db.Bots(r.Context(), ownerID, false)
	if err != nil {
		return err
	}
	for _, bot := range bots {
		if err := s.deleteBot(r, bot); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	return nil
}

// eraseAccount deletes an account: it's signed out everywhere but on exceptDevice,
// which asked and has its answer, taken out of its chats, and what it kept here is
// erased. What it sent stays with everyone who has it.
func (s *Server) eraseAccount(r *http.Request, userID, exceptDevice string) error {
	ctx := r.Context()
	groups, err := s.db.UserGroupIDs(ctx, userID)
	if err != nil {
		return err
	}
	to := s.hearersOf(ctx, userID)
	// Said before taking them out of their groups, as a ban does.
	s.hub.ToUsersExcept([]string{userID}, exceptDevice, Event{Type: "force_logout", Data: map[string]string{"reason": "account_deleted"}})
	for _, groupID := range groups {
		if err := s.removeFromRoster(r, groupID, userID, userID); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
	}
	avatar, err := s.db.DeleteAccount(ctx, userID)
	if err != nil {
		return err
	}
	if avatar != "" {
		s.removeFiles(ctx, []string{avatar})
	}
	s.endVoiceFor(ctx, userID, "account_deleted", true)
	s.hub.EndPresence(userID)
	s.hub.Disconnect(userID, "")
	s.tell(ctx, userID, to)
	return nil
}

// handleBotChannels gives a listed bot the channels it may join, which is for the
// server's admins to say. It joins them by itself, and leaves any taken away.
func (s *Server) handleBotChannels(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		Channels []string `json:"channels"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Channels) > maxBotChannels || slices.ContainsFunc(body.Channels, func(id string) bool { return !store.ValidID(id) }) {
		writeError(w, http.StatusBadRequest, "bad_request", "Those channels aren't valid.")
		return
	}
	bot, err := s.db.Bot(r.Context(), r.PathValue("id"))
	if err == nil && !bot.Listed && bot.OwnerID != sess.UserID {
		err = store.ErrNotFound
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !bot.Listed || !bot.SetUp {
		writeError(w, http.StatusForbidden, "private_bot", "Only a listed bot that's set up can be in channels.")
		return
	}
	left, err := s.db.SetBotChannels(r.Context(), bot.ID, body.Channels)
	if err != nil {
		writeFailure(w, err)
		return
	}
	for _, channelID := range left {
		if err := s.removeFromRoster(r, channelID, sess.UserID, bot.ID); err != nil && !errors.Is(err, store.ErrNotFound) {
			writeFailure(w, err)
			return
		}
	}
	// Which it joins, and which it's out of.
	s.hub.ToUsers([]string{bot.ID}, Event{Type: "channels"})
	updated, err := s.db.Bot(r.Context(), bot.ID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bot": updated})
}

// More than a server has channels.
const maxBotChannels = 1000

// botMayJoin says whether a bot may come into a channel: only one it was given.
func (s *Server) botMayJoin(ctx context.Context, botID, channelID string) (bool, error) {
	channels, err := s.db.BotChannels(ctx, botID)
	return slices.Contains(channels, channelID), err
}

func validMaxBots(n int) bool { return n >= 0 && n <= maxMaxBots }

func formatMaxBots(n int) string { return strconv.Itoa(n) }
