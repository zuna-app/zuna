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
	writeJSON(w, http.StatusOK, map[string]any{"groups": groups})
}

func (s *Server) handleCreateGroup(w http.ResponseWriter, r *http.Request, sess *store.Session) {
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

func memberIDs(group *store.Group) []string {
	ids := make([]string, len(group.Members))
	for i, member := range group.Members {
		ids[i] = member.UserID
	}
	return ids
}

func (s *Server) handleGroup(w http.ResponseWriter, r *http.Request, _ *store.Session, _ *store.GroupMember) {
	group, err := s.db.Group(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, group)
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
		ExpectedEpoch int64                `json:"expected_epoch"`
		Commit        []byte               `json:"commit"`
		GroupInfo     []byte               `json:"group_info"`
		Kind          string               `json:"kind"`
		AddUsers      []string             `json:"add_users"`
		RemoveUsers   []string             `json:"remove_users"`
		Welcomes      []store.Welcome      `json:"welcomes"`
		Meta          []byte               `json:"meta"`
		MetaEpoch     *int64               `json:"meta_epoch"`
		HistoryGrants []store.HistoryGrant `json:"history_grants"`
	}
	if !readJSONUpTo(w, r, maxCommitBody, &body) {
		return
	}
	if len(body.Commit) == 0 || len(body.GroupInfo) == 0 {
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
		Kind:          body.Kind,
		AddUsers:      body.AddUsers,
		RemoveUsers:   body.RemoveUsers,
		Welcomes:      body.Welcomes,
		Meta:          body.Meta,
		MetaEpoch:     body.MetaEpoch,
		HistoryGrants: body.HistoryGrants,
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
	s.hub.ToUsers(memberIDs(group), Event{Type: "group", Data: group})
	for _, user := range body.RemoveUsers {
		s.hub.ToUsers([]string{user}, Event{Type: "group_removed", Data: map[string]string{"group_id": groupID}})
	}
	if len(body.Welcomes) > 0 {
		s.hub.ToUsers(memberIDs(group), Event{Type: "welcome", Data: map[string]string{"group_id": groupID}})
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
	}
	if !readJSONUpTo(w, r, maxCommitBody, &body) {
		return
	}
	byAdmin := member.Role == "admin"
	// Only the very start has no group info to go back to.
	valid := body.To >= 0 && body.To < body.From &&
		(!byAdmin || (body.To == 0 && body.From == 1 && len(body.GroupInfo) == 0) || validGroupInfoFrame(body.GroupInfo, groupID, body.To))
	if !valid {
		writeError(w, http.StatusBadRequest, "bad_request", "That isn't a valid state for this conversation.")
		return
	}
	event, senders, err := s.db.VoidCommits(r.Context(), groupID, sess.UserID, sess.DeviceID, byAdmin, body.From, body.To, body.GroupInfo)
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
	s.hub.ToUsers(memberIDs(group), Event{Type: "group", Data: group})
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
	if group, err := s.db.Group(r.Context(), groupID); err != nil {
		writeFailure(w, err)
		return
	} else if group.Kind == "dm" {
		writeError(w, http.StatusBadRequest, "bad_request", "A direct message has no details to change.")
		return
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
	s.hub.ToUsers(memberIDs(group), Event{Type: "group", Data: group})
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
	if len(group.Members) == 1 {
		files, err := s.db.DeleteGroup(r.Context(), groupID)
		if err != nil {
			writeFailure(w, err)
			return
		}
		s.removeFiles(r.Context(), files)
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
	return nil
}

func (s *Server) handleGroupRole(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	groupID := r.PathValue("id")
	if member.Role != "admin" {
		writeError(w, http.StatusForbidden, "forbidden", "Only an admin of this group can change roles.")
		return
	}
	var body struct {
		Role string `json:"role"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if body.Role != "admin" && body.Role != "member" {
		writeError(w, http.StatusBadRequest, "bad_request", "Unknown role.")
		return
	}
	if group, err := s.db.Group(r.Context(), groupID); err != nil {
		writeFailure(w, err)
		return
	} else if group.Kind == "dm" {
		writeError(w, http.StatusBadRequest, "bad_request", "A direct message has no roles to change.")
		return
	}
	if err := s.db.SetGroupMemberRole(r.Context(), groupID, r.PathValue("user"), body.Role); err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastGroup(r, groupID)
	writeOK(w)
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	groupID := r.PathValue("id")
	var body struct {
		Data []byte `json:"data"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Data) > 1024 {
		writeError(w, http.StatusBadRequest, "bad_request", "The read state is too large.")
		return
	}
	if err := s.db.SetReadState(r.Context(), groupID, sess.UserID, body.Data); err != nil {
		writeFailure(w, err)
		return
	}
	members, err := s.db.GroupMemberIDs(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
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
	changes, err := s.db.ChangesAfter(r.Context(), r.PathValue("id"), queryInt(r, "after", 0), member.VisibleFromSeq, clampLimit(queryInt(r, "limit", 200), 500))
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
	maxReactionBytes = 2 << 10
)

func (s *Server) handleMessages(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	limit := clampLimit(queryInt(r, "limit", 50), 200)
	groupID := r.PathValue("id")
	var messages []*store.Message
	var err error
	if around := queryInt(r, "around", 0); around > 0 {
		messages, err = s.db.MessagesAround(r.Context(), groupID, around, member.VisibleFromSeq, limit)
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

// broadcastMessage tells all of the group's devices about a message's new state.
// The sender's own device is included: the socket is each client's complete,
// ordered feed, and clients ignore what they have already applied.
func (s *Server) broadcastMessage(r *http.Request, groupID string, message *store.Message) {
	members, err := s.db.GroupMemberIDs(r.Context(), groupID)
	if err != nil {
		return
	}
	s.hub.ToUsers(members, Event{Type: "message", Data: message})
}

func (s *Server) handleSendMessage(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	groupID := r.PathValue("id")
	if !s.messageLimiter.Allow(sess.UserID) {
		writeError(w, http.StatusTooManyRequests, "rate_limited", "You're sending messages too quickly.")
		return
	}
	var body struct {
		ID       string   `json:"id"`
		Epoch    int64    `json:"epoch"`
		Envelope []byte   `json:"envelope"`
		FileIDs  []string `json:"file_ids"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !store.ValidID(body.ID) || len(body.Envelope) == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "The message is incomplete.")
		return
	}
	if len(body.Envelope) > maxEnvelopeBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That message is too long.")
		return
	}
	for _, fileID := range body.FileIDs {
		if !store.ValidID(fileID) {
			writeError(w, http.StatusBadRequest, "bad_request", "An attachment isn't valid.")
			return
		}
	}
	message, created, err := s.db.CreateMessage(r.Context(), store.Message{
		GroupID:      groupID,
		ID:           body.ID,
		SenderUser:   sess.UserID,
		SenderDevice: sess.DeviceID,
		Epoch:        body.Epoch,
		Envelope:     body.Envelope,
	}, body.FileIDs, s.quotaBytes())
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastMessage(r, groupID, message)
	if created {
		s.pushMessage(groupID, message)
	}
	writeJSON(w, http.StatusCreated, message)
}

func (s *Server) handleEditMessage(w http.ResponseWriter, r *http.Request, sess *store.Session, _ *store.GroupMember) {
	groupID := r.PathValue("id")
	var body struct {
		Epoch    int64  `json:"epoch"`
		Envelope []byte `json:"envelope"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if len(body.Envelope) == 0 || len(body.Envelope) > maxEnvelopeBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "The edited message isn't valid.")
		return
	}
	message, err := s.db.EditMessage(r.Context(), groupID, r.PathValue("mid"), sess.UserID, sess.DeviceID, body.Epoch, body.Envelope, s.quotaBytes())
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastMessage(r, groupID, message)
	writeJSON(w, http.StatusOK, message)
}

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
	groupID := r.PathValue("id")
	messageID := r.PathValue("mid")
	existing := s.visibleMessage(w, r, member)
	if existing == nil {
		return
	}
	group, err := s.db.Group(r.Context(), groupID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// In a DM only the sender can delete; in a group, its admins can moderate.
	canModerate := group.Kind == "group" && member.Role == "admin"
	if existing.SenderUser != sess.UserID && !canModerate {
		writeError(w, http.StatusForbidden, "forbidden", "You can only delete your own messages.")
		return
	}
	message, files, err := s.db.DeleteMessage(r.Context(), groupID, messageID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.removeFiles(r.Context(), files)
	s.broadcastMessage(r, groupID, message)
	if members, err := s.db.GroupMemberIDs(r.Context(), groupID); err == nil {
		s.pushDeletion(members, groupID, messageID)
	}
	writeJSON(w, http.StatusOK, message)
}

func (s *Server) handleAddReaction(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
	groupID := r.PathValue("id")
	if s.visibleMessage(w, r, member) == nil {
		return
	}
	var body struct {
		ID    string `json:"id"`
		Epoch int64  `json:"epoch"`
		Data  []byte `json:"data"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !store.ValidID(body.ID) || len(body.Data) == 0 || len(body.Data) > maxReactionBytes {
		writeError(w, http.StatusBadRequest, "bad_request", "The reaction isn't valid.")
		return
	}
	message, err := s.db.AddReaction(r.Context(), groupID, r.PathValue("mid"), store.Reaction{
		ID:     body.ID,
		UserID: sess.UserID,
		Epoch:  body.Epoch,
		Data:   body.Data,
	}, s.quotaBytes())
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastMessage(r, groupID, message)
	writeJSON(w, http.StatusOK, message)
}

func (s *Server) handleRemoveReaction(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
	groupID := r.PathValue("id")
	if s.visibleMessage(w, r, member) == nil {
		return
	}
	message, err := s.db.RemoveReaction(r.Context(), groupID, r.PathValue("mid"), r.PathValue("rid"), sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	s.broadcastMessage(r, groupID, message)
	writeJSON(w, http.StatusOK, message)
}

func (s *Server) handlePin(pinned bool) memberHandler {
	return func(w http.ResponseWriter, r *http.Request, sess *store.Session, member *store.GroupMember) {
		groupID := r.PathValue("id")
		if s.visibleMessage(w, r, member) == nil {
			return
		}
		message, err := s.db.SetPinned(r.Context(), groupID, r.PathValue("mid"), sess.UserID, pinned)
		if err != nil {
			writeFailure(w, err)
			return
		}
		s.broadcastMessage(r, groupID, message)
		writeJSON(w, http.StatusOK, message)
	}
}

func (s *Server) handlePins(w http.ResponseWriter, r *http.Request, _ *store.Session, member *store.GroupMember) {
	pins, err := s.db.Pins(r.Context(), r.PathValue("id"), member.VisibleFromSeq)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": pins})
}
