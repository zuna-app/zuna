package api

import (
	"net/http"
	"strconv"

	"zuna/server/internal/store"
)

func (s *Server) handleGroups(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	groups, err := s.db.UserGroups(r.Context(), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	for i, group := range groups {
		groups[i] = seenBy(group, sess.UserID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	// A bot is brought into chats. It never starts one, so it can't write to anyone first.
	if refuseBot(w, sess) {
		return
	}
	var body struct {
		Kind           string `json:"kind"`
		PeerID         string `json:"peer_id"`
		HistoryVisible bool   `json:"history_visible"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	switch body.Kind {
	case "dm":
		group, created, err := s.db.GetOrCreateDM(r.Context(), sess.UserID, body.PeerID)
		if err != nil {
			writeFailure(w, err)
			return
		}
		if created {
			s.hub.ToUsersExcept(memberIDs(group), sess.DeviceID, Event{Type: "group", Data: group})
		}
		writeJSON(w, http.StatusOK, map[string]any{"group": group, "created": created})
	case "group":
		group, err := s.db.CreateGroup(r.Context(), sess.UserID, body.HistoryVisible)
		if err != nil {
			writeFailure(w, err)
			return
		}
		s.hub.ToUsersExcept([]string{sess.UserID}, sess.DeviceID, Event{Type: "group", Data: group})
		writeJSON(w, http.StatusCreated, map[string]any{"group": group, "created": true})
	default:
		writeError(w, http.StatusBadRequest, "bad_request", "Unknown conversation type.")
	}
}

// seenBy is a group as it goes to one person, or to all its members at once with
// no one named. Nobody has read ticks in a channel, and each reader seals where
// they are there to their own account, so only the person's own read position
// goes, and none to everyone: theirs reach their devices in read frames. In a
// channel of everyone on a server, the others' were a third of what was sent.
func seenBy(group *store.Group, userID string) *store.Group {
	if group.Kind != "channel" {
		return group
	}
	seen := *group
	seen.Members = make([]store.GroupMember, len(group.Members))
	for i, member := range group.Members {
		if member.UserID != userID {
			member.ReadState = nil
		}
		seen.Members[i] = member
	}
	return &seen
}

func memberIDs(group *store.Group) []string {
	ids := make([]string, len(group.Members))
	for i, member := range group.Members {
		ids[i] = member.UserID
	}
	return ids
}

func (s *Server) handleGroup(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	group, err := s.db.Group(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, seenBy(group, sess.UserID))
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
	groupID := r.PathValue("id")
	group, err := s.db.Group(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Both people in a DM are its admins, but neither may erase it for the other.
	if group.Kind == "dm" {
		writeError(w, http.StatusBadRequest, "bad_request", "A direct message can't be deleted. You can hide it instead.")
		return
	}
	if group.Kind == "channel" {
		writeError(w, http.StatusBadRequest, "bad_request", "A channel is deleted through the server's channels.")
		return
	}
	if member.Role != "admin" && sess.Role != "owner" {
		writeError(w, http.StatusForbidden, "forbidden", "Only an admin of this conversation can delete it.")
		return
	}
	files, err := s.db.DeleteGroup(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.removeFiles(r.Context(), files)
	s.endVoiceIn(r.Context(), groupID)
	s.hub.ToUsers(memberIDs(group), Event{Type: "group_removed", Data: map[string]string{"group_id": groupID}})
	writeOK(w)
}

func (s *Server) handleCommit(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	groupID := r.PathValue("id")
	// Every commit makes everyone do work, and one nobody can apply stops the group
	// until it's undone, so sending those is what earns a wait.
	if !s.commitHolds.Allowed(groupID+"/"+sess.UserID) || !s.commitLimiter.Allow(groupID+"/"+sess.UserID) || !s.userCommitLimiter.Allow(sess.UserID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many changes to this conversation at once. Please wait a moment.")
		return
	}
	var body struct {
		ExpectedEpoch int64    `json:"expected_epoch"`
		Commit        []byte   `json:"commit"`
		GroupInfo     []byte   `json:"group_info"`
		SendKey       []byte   `json:"send_key"`
		Kind          string   `json:"kind"`
		AddUsers      []string `json:"add_users"`
		RemoveUsers   []string `json:"remove_users"`
		// One welcome, for every device it adds: with hybrid keys it carries a tree of several
		// kilobytes a device, so it goes up once (docs/POST_QUANTUM.md).
		Welcome       []byte               `json:"welcome"`
		WelcomeTo     []string             `json:"welcome_to"`
		Meta          []byte               `json:"meta"`
		MetaEpoch     *int64               `json:"meta_epoch"`
		HistoryGrants []store.HistoryGrant `json:"history_grants"`
		Admins        *[]string            `json:"admins"`
	}
	if !readJSONUpTo(w, r, maxCommitBody, &body) {
		return
	}
	if len(body.Commit) == 0 || len(body.GroupInfo) == 0 || len(body.SendKey) != store.SendKeyLen {
		writeError(w, http.StatusBadRequest, "bad_request", "The commit is incomplete.")
		return
	}
	if len(body.Meta) > maxDetailBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Those group details are too large.")
		return
	}
	// Advancing the group on anything else would strand every member.
	if !validCommitFrame(body.Commit, groupID, body.ExpectedEpoch) || !validGroupInfoFrame(body.GroupInfo, groupID, body.ExpectedEpoch+1) {
		writeError(w, http.StatusBadRequest, "invalid_commit", "That isn't a valid commit for this conversation.")
		return
	}
	if (len(body.Welcome) == 0) != (len(body.WelcomeTo) == 0) || (len(body.Welcome) > 0 && !validWelcomeFrame(body.Welcome)) {
		writeError(w, http.StatusBadRequest, "invalid_commit", "That isn't a valid commit for this conversation.")
		return
	}
	welcomes := make([]store.Welcome, 0, len(body.WelcomeTo))
	for _, device := range body.WelcomeTo {
		welcomes = append(welcomes, store.Welcome{DeviceID: device, Data: body.Welcome})
	}
	before, err := s.db.GroupMemberIDs(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	event, err := s.db.ApplyCommit(r.Context(), store.Commit{
		GroupID:       groupID,
		SenderUser:    sess.UserID,
		SenderDevice:  sess.DeviceID,
		ExpectedEpoch: body.ExpectedEpoch,
		Data:          body.Commit,
		GroupInfo:     body.GroupInfo,
		SendKey:       body.SendKey,
		Kind:          body.Kind,
		AddUsers:      body.AddUsers,
		RemoveUsers:   body.RemoveUsers,
		Welcomes:      welcomes,
		Meta:          body.Meta,
		MetaEpoch:     body.MetaEpoch,
		HistoryGrants: body.HistoryGrants,
		Admins:        body.Admins,
		Quota:         s.quotaBytes(),
	})
	if err != nil {
		writeFailure(w, err)
		return
	}
	group, err := s.db.Group(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// Removed users are still told, so their clients learn from the commit.
	s.hub.ToUsers(before, Event{Type: "event", Data: event})
	s.hub.ToUsers(memberIDs(group), Event{Type: "group", Data: seenBy(group, "")})
	for _, user := range body.RemoveUsers {
		s.hub.ToUsers([]string{user}, Event{Type: "group_removed", Data: map[string]string{"group_id": groupID}})
	}
	if len(body.RemoveUsers) > 0 {
		s.endVoiceOf(r.Context(), groupID, body.RemoveUsers)
	}
	if len(welcomes) > 0 {
		s.hub.ToUsers(memberIDs(group), Event{Type: "welcome", Data: map[string]string{"group_id": groupID}})
	}
	// A private bot is there for everyone in the group from now on.
	for _, user := range body.AddUsers {
		if bot, err := s.db.BotRules(r.Context(), user); err == nil && bot != nil && !bot.Listed {
			s.broadcastUser(r, user)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"seq": event.Seq, "epoch": event.Epoch})
}

// handleVoidCommits undoes a commit nobody can apply: well formed, so it got past
// the check above, but no member's MLS state can follow it. A member whose device
// still holds the last good epoch brings the group back to it, and everyone who
// never left that epoch carries on. Any member can, so that a group doesn't wait for
// an admin, within what VoidCommits allows them.
func (s *Server) handleVoidCommits(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
	groupID := r.PathValue("id")
	if !s.voidLimiter.Allow(groupID + "/" + sess.UserID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many changes to this conversation at once. Please wait a moment.")
		return
	}
	var body struct {
		From      int64  `json:"from_epoch"`
		To        int64  `json:"to_epoch"`
		GroupInfo []byte `json:"group_info"`
		// The send key of the epoch an admin takes the group back to, with its group info.
		SendKey []byte `json:"send_key"`
	}
	if !readJSONUpTo(w, r, maxCommitBody, &body) {
		return
	}
	byAdmin := member.Role == "admin"
	// Only the very start has no group info to go back to.
	valid := body.To >= 0 && body.To < body.From &&
		(!byAdmin || (body.To == 0 && body.From == 1 && len(body.GroupInfo) == 0) || (validGroupInfoFrame(body.GroupInfo, groupID, body.To) && len(body.SendKey) == store.SendKeyLen))
	if !valid {
		writeError(w, http.StatusBadRequest, "bad_request", "That isn't a valid state for this conversation.")
		return
	}
	event, senders, err := s.db.VoidCommits(r.Context(), groupID, sess.UserID, sess.DeviceID, byAdmin, body.From, body.To, body.GroupInfo, body.SendKey)
	if err != nil {
		writeFailure(w, err)
		return
	}
	for _, sender := range senders {
		s.commitHolds.Fail(groupID + "/" + sender)
	}
	group, err := s.db.Group(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.hub.ToUsers(memberIDs(group), Event{Type: "event", Data: event})
	s.hub.ToUsers(memberIDs(group), Event{Type: "group", Data: seenBy(group, "")})
	writeOK(w)
}

func (s *Server) handleGroupInfo(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.GroupMember) {
	info, epoch, err := s.db.GroupInfo(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"group_info": info, "epoch": epoch})
}

func (s *Server) handleGroupMeta(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	groupID := r.PathValue("id")
	if member.Role != "admin" {
		writeError(w, http.StatusForbidden, "forbidden", "Only an admin of this group can change its details.")
		return
	}
	var body struct {
		Meta           []byte `json:"meta"`
		Epoch          int64  `json:"epoch"`
		HistoryVisible *bool  `json:"history_visible"`
	}
	if !readJSONUpTo(w, r, maxDetailsBody, &body) {
		return
	}
	if len(body.Meta) > maxDetailBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "Those group details are too large.")
		return
	}
	// A direct message's two people are both its admins, and its details only say
	// how long its messages last. Whether history is shared means nothing there.
	if kind, err := s.db.GroupKind(r.Context(), groupID); err != nil {
		writeFailure(w, err)
		return
	} else if kind == "dm" {
		body.HistoryVisible = nil
	}
	if err := s.db.SetGroupMeta(r.Context(), groupID, body.Meta, body.Epoch, body.HistoryVisible); err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastGroup(r, groupID)
	writeOK(w)
}

func (s *Server) broadcastGroup(r *http.Request, groupID string) {
	group, err := s.db.Group(r.Context(), groupID)
	if err != nil {
		return
	}
	s.hub.ToUsers(memberIDs(group), Event{Type: "group", Data: seenBy(group, "")})
}

// handleLeave takes the caller out of the roster. Until a remaining member's
// client commits the removal the leaver could still derive the current epoch's
// keys, but the server no longer delivers anything to them.
func (s *Server) handleLeave(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	groupID := r.PathValue("id")
	group, err := s.db.Group(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if group.Kind == "dm" {
		writeError(w, http.StatusBadRequest, "bad_request", "A direct message can't be left. You can hide it instead.")
		return
	}
	if group.Kind == "channel" {
		writeError(w, http.StatusBadRequest, "bad_request", "A channel can't be left. You can mute it instead.")
		return
	}
	if len(group.Members) == 1 {
		files, err := s.db.DeleteGroup(r.Context(), groupID)
		if err != nil {
			writeFailure(w, err)
			return
		}
		s.removeFiles(r.Context(), files)
		s.endVoiceIn(r.Context(), groupID)
		s.hub.ToUsers([]string{sess.UserID}, Event{Type: "group_removed", Data: map[string]string{"group_id": groupID}})
		writeOK(w)
		return
	}
	if err := s.removeFromRoster(r, groupID, sess.UserID, sess.UserID); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

// removeFromRoster removes a user without an MLS commit and tells everyone, so
// that a remaining member's client commits the leaf removal.
func (s *Server) removeFromRoster(r *http.Request, groupID, actor, target string) error {
	event, err := s.db.RemoveMember(r.Context(), groupID, actor, target)
	if err != nil {
		return err
	}
	if _, err := s.db.PromoteIfNoAdmin(r.Context(), groupID); err != nil {
		return err
	}
	remaining, err := s.db.GroupMemberIDs(r.Context(), groupID)
	if err != nil {
		return err
	}
	s.hub.ToUsers(remaining, Event{Type: "event", Data: event})
	s.broadcastGroup(r, groupID)
	s.hub.ToUsers([]string{target}, Event{Type: "group_removed", Data: map[string]string{"group_id": groupID}})
	s.endVoiceOf(r.Context(), groupID, []string{target})
	return nil
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	groupID := r.PathValue("id")
	var body struct {
		Data []byte `json:"data"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Data) > maxReadStateBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "The read state is too large.")
		return
	}
	if err := s.db.SetReadState(r.Context(), groupID, sess.UserID, body.Data); err != nil {
		writeFailure(w, err)
		return
	}
	// Nobody has read ticks in a channel, so where someone is goes only to their own
	// devices, and the channel's members, who may be everyone on the server, aren't read.
	members := []string{sess.UserID}
	if kind, err := s.db.GroupKind(r.Context(), groupID); err != nil || kind != "channel" {
		if members, err = s.db.GroupMemberIDs(r.Context(), groupID); err != nil {
			writeFailure(w, err)
			return
		}
	}
	s.hub.ToUsersExcept(members, sess.DeviceID, Event{Type: "read", Data: map[string]any{
		"group_id": groupID,
		"user_id":  sess.UserID,
		"data":     body.Data,
	}})
	s.pushRead(sess.UserID, sess.DeviceID, groupID)
	writeOK(w)
}

func (s *Server) handleChanges(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	changes, err := s.db.ChangesAfter(r.Context(), r.PathValue("id"), queryInt(r, "after", 0), member.VisibleFromSeq, queryLimit(r, 200, 500))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, changes)
}

func (s *Server) handleWelcomes(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	welcomes, err := s.db.Welcomes(r.Context(), sess.DeviceID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"welcomes": welcomes})
}

func (s *Server) handleDeleteWelcome(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "That welcome ID isn't valid.")
		return
	}
	if err := s.db.DeleteWelcome(r.Context(), sess.DeviceID, id); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

// --- Messages ---

const (
	maxEnvelopeBytes = 256 << 10
	// The longest a disappearing message may last, in seconds: a year.
	maxExpiresIn = 366 * 24 * 60 * 60
	// A reaction, pin or deletion is a short envelope its device signed, with a hybrid
	// signature of 2,485 bytes inside (docs/POST_QUANTUM.md). A reaction comes to under
	// 3 KiB, which every member carries, so it's held closer than the rest.
	maxReactionBytes = 4 << 10
	maxProofBytes    = 5 << 10
	maxProofBody     = 16 << 10
	// A read position, the same, framed with its epoch.
	maxReadStateBytes = 4 << 10
)

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	limit := queryLimit(r, 50, 200)
	groupID := r.PathValue("id")
	var messages []*store.Message
	var err error
	if around := queryInt(r, "around", 0); around > 0 {
		messages, err = s.db.MessagesAround(r.Context(), groupID, around, member.VisibleFromSeq, limit)
	} else if r.URL.Query().Has("after") {
		messages, err = s.db.MessagesAfter(r.Context(), groupID, queryInt(r, "after", 0), member.VisibleFromSeq, limit)
	} else {
		messages, err = s.db.MessagesBefore(r.Context(), groupID, queryInt(r, "before", 1<<62), member.VisibleFromSeq, limit)
	}
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": messages})
}

func (s *Server) handleMessage(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	if message := s.visibleMessage(w, r, member); message != nil {
		writeJSON(w, http.StatusOK, message)
	}
}

// visibleMessage is the message a request is about, if this member may see it. What
// came before they joined isn't there for them, whichever route they ask through.
func (s *Server) visibleMessage(w http.ResponseWriter, r *http.Request, member *store.GroupMember) *store.Message {
	message, err := s.db.Message(r.Context(), r.PathValue("id"), r.PathValue("mid"))
	if err != nil {
		writeFailure(w, err)
		return nil
	}
	if message.Seq <= member.VisibleFromSeq {
		writeError(w, http.StatusNotFound, "not_found", "That message isn't available to you.")
		return nil
	}
	return message
}

// liveMessage is a message as it goes out live, and as sealed requests are answered:
// without its reactions, which go one at a time (broadcastReaction), so that changing a
// message with many costs nobody all of them again. Apps keep the ones they hold. Only
// fetching it, as a device that's behind does, gives the full set.
type liveMessage struct {
	*store.Message
	Reactions []store.Reaction `json:"reactions,omitempty"`
}

func live(message *store.Message) liveMessage {
	return liveMessage{Message: message}
}

// broadcastMessage tells the group's devices about a message's new state, all but those
// of anyone added after it without the group's history, who can't fetch it either. The
// sender's own device is included: the socket is each client's complete, ordered feed,
// and clients ignore what they have already applied.
func (s *Server) broadcastMessage(r *http.Request, groupID string, message *store.Message) []string {
	members, err := s.db.MessageAudience(r.Context(), groupID, message.Seq)
	if err != nil {
		return nil
	}
	s.hub.ToUsers(members, Event{Type: "message", Data: live(message)})
	return members
}

// broadcastReaction tells the same devices about one reaction added or taken back.
func (s *Server) broadcastReaction(r *http.Request, change *store.ReactionChange) {
	members, err := s.db.MessageAudience(r.Context(), change.GroupID, change.Seq)
	if err != nil {
		return
	}
	s.hub.ToUsers(members, Event{Type: "reaction", Data: change})
}

// handleClearReaction is a group's admin dropping a reaction that opens for nobody, which
// their app finds and asks for by itself, as it's for the server to check their role. A
// member can only take back their own, sealed, by its item key.
func (s *Server) handleClearReaction(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	if s.visibleMessage(w, r, member) == nil {
		return
	}
	reactionID := r.PathValue("rid")
	if !store.ValidID(reactionID) {
		writeError(w, http.StatusNotFound, "not_found", "That reaction doesn't exist.")
		return
	}
	kind, err := s.db.GroupKind(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	if kind == "dm" || member.Role != "admin" {
		writeError(w, http.StatusForbidden, "forbidden", "Only an admin of this conversation can remove someone else's reactions.")
		return
	}
	change, dropped, err := s.db.ClearReaction(r.Context(), r.PathValue("id"), r.PathValue("mid"), reactionID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if dropped {
		s.broadcastReaction(r, change)
	}
	writeJSON(w, http.StatusOK, change)
}

// handleDeleteMessage is a group's admin deleting someone else's message, which is named,
// as it's the server's to check their role. It says who moderated, not who wrote. The
// server doesn't keep who: the proof inside says so to the apps. An author deleting
// their own is sealed (handleSealedDelete), and in a direct message there's only that.
func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	if s.visibleMessage(w, r, member) == nil {
		return
	}
	kind, err := s.db.GroupKind(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	if kind == "dm" || member.Role != "admin" {
		writeError(w, http.StatusForbidden, "forbidden", "Only an admin of this conversation can delete someone else's messages.")
		return
	}
	// What the deleting device signed, which other members check before erasing their copies.
	var body struct {
		Epoch    *int64 `json:"epoch"`
		Deletion []byte `json:"deletion"`
	}
	if !readJSONUpTo(w, r, maxProofBody, &body) {
		return
	}
	if len(body.Deletion) == 0 || body.Epoch == nil || len(body.Deletion) > maxProofBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "The deletion isn't valid.")
		return
	}
	s.deleteMessage(w, r, r.PathValue("id"), store.Deletion{Proof: body.Deletion, Epoch: *body.Epoch}, nil)
}

func (s *Server) handlePins(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	pins, err := s.db.Pins(r.Context(), r.PathValue("id"), member.VisibleFromSeq)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": pins})
}
