package api

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"zuna/server/internal/store"
)

// Who may be in a room on the media server is decided again whenever someone comes in. A
// token outlives what let someone have it: this server's last voiceTokenTTL, and those
// LiveKit hands a participant to come back with, ten minutes. So taking someone off a
// conversation's roster, banning them, or revoking a device, takes it out of the room, and
// whatever it comes back in with is turned away here. A device is taken out of the rooms it
// said it's in, and of those it was let into lately without saying so (voiceRooms.passes).
//
// Where apps reach LiveKit through this server, at /livekit/, a request that isn't let in
// never gets there. Where they reach it at its own address, LiveKit says who came in, with
// its webhook, and anyone the room isn't for is taken straight back out.

// liveKitLeeway is how far a token's times may be out, as LiveKit allows.
const liveKitLeeway = time.Minute

// maxLiveKitEvent is the largest of LiveKit's webhooks this server reads.
const maxLiveKitEvent = 64 << 10

var errNotLiveKits = errors.New("not a token of this server's key")

// liveKitClaims is what this server reads of a token signed with the secret it shares with
// LiveKit: one it gave an app, one LiveKit gave an app in its place, or one a webhook
// came with.
type liveKitClaims struct {
	Issuer    string  `json:"iss"`
	Subject   string  `json:"sub"`
	NotBefore float64 `json:"nbf"`
	Expires   float64 `json:"exp"`
	// The base64 of a webhook's body's SHA-256.
	Sha256 string `json:"sha256"`
	Video  struct {
		Room     string `json:"room"`
		RoomJoin bool   `json:"roomJoin"`
	} `json:"video"`
}

// readLiveKitToken checks that a token was signed with the secret this server shares with
// LiveKit, under its key, and is good now, and says what it claims.
func (s *Server) readLiveKitToken(token string) (*liveKitClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return nil, errNotLiveKits
	}
	decode := base64.RawURLEncoding.DecodeString
	var header struct {
		Alg string `json:"alg"`
	}
	if raw, err := decode(parts[0]); err != nil || json.Unmarshal(raw, &header) != nil || header.Alg != "HS256" {
		return nil, errNotLiveKits
	}
	mac := hmac.New(sha256.New, []byte(s.cfg.LiveKitSecret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	if signature, err := decode(parts[2]); err != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return nil, errNotLiveKits
	}
	var claims liveKitClaims
	if raw, err := decode(parts[1]); err != nil || json.Unmarshal(raw, &claims) != nil {
		return nil, errNotLiveKits
	}
	now := float64(time.Now().Unix())
	leeway := liveKitLeeway.Seconds()
	if claims.Issuer != s.cfg.LiveKitKey || claims.Expires+leeway < now || claims.NotBefore-leeway > now {
		return nil, errNotLiveKits
	}
	return &claims, nil
}

// admitted says whether whoever a room's identity names may be in that room now.
func (s *Server) admitted(ctx context.Context, identity, room string) (bool, error) {
	userID, deviceID, ok := strings.Cut(identity, ".")
	if !ok || !store.ValidID(userID) || !store.ValidID(deviceID) || !store.ValidID(room) {
		return false, nil
	}
	return s.db.MayBeInRoom(ctx, room, userID, deviceID)
}

// liveKitTokenOf is the one token a request to the media server carries: in its
// Authorization header, as a bearer's, in its query's access_token, or in both, the same.
// LiveKit goes by the header and then the query, so a request with two different ones,
// whichever it would go by, or a header it would refuse, carries none here. Every request an
// app sends LiveKit carries one, in one of the two.
func liveKitTokenOf(r *http.Request) (string, bool) {
	var token string
	one := func(found string) bool {
		if found == "" || (token != "" && found != token) {
			return false
		}
		token = found
		return true
	}
	for _, header := range r.Header.Values("Authorization") {
		found, bearer := strings.CutPrefix(header, "Bearer ")
		if !bearer || !one(found) {
			return "", false
		}
	}
	query, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return "", false
	}
	for _, found := range query["access_token"] {
		if !one(found) {
			return "", false
		}
	}
	return token, token != ""
}

// mayEnter says whether a request on its way to the media server through /livekit/ is let
// through, and with which token: only one to join a room, for a device the room is for now.
func (s *Server) mayEnter(r *http.Request) (string, *liveKitClaims, bool, error) {
	token, ok := liveKitTokenOf(r)
	if !ok {
		return "", nil, false, nil
	}
	claims, err := s.readLiveKitToken(token)
	if err != nil || !claims.Video.RoomJoin {
		return "", nil, false, nil
	}
	admitted, err := s.admitted(r.Context(), claims.Subject, claims.Video.Room)
	return token, claims, admitted, err
}

// enteringWith is the context's key for the token a request came through the door with.
type enteringWith struct{}

// passOnToken has a request through /livekit/ carry to the media server the token it was let
// through with, and nothing else LiveKit could read one from: in its Authorization header,
// with access_token out of its query. Whatever the caller sent there or named in Connection,
// which the proxy drops on the way, LiveKit then reads the token the door checked.
func passOnToken(request *httputil.ProxyRequest) {
	token, _ := request.In.Context().Value(enteringWith{}).(string)
	request.Out.Header.Set("Authorization", "Bearer "+token)
	query := request.Out.URL.Query()
	if _, ok := query["access_token"]; ok {
		query.Del("access_token")
		request.Out.URL.RawQuery = query.Encode()
	}
}

// liveKitEvent is what this server reads of what LiveKit's webhook tells it.
type liveKitEvent struct {
	Event string `json:"event"`
	Room  struct {
		Name string `json:"name"`
	} `json:"room"`
	Participant struct {
		Identity string `json:"identity"`
	} `json:"participant"`
}

// handleLiveKitEvent hears from LiveKit as someone comes into a room, and takes them straight
// back out if the room isn't for them now. LiveKit signs each with a token of the key and
// secret it shares with this server, over the body's hash, which is all that lets one in.
// It says so once their connection is up, so one that never gets that far is LiveKit's to
// drop, which it does a minute later.
func (s *Server) handleLiveKitEvent(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxLiveKitEvent))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "The request couldn't be read.")
		return
	}
	claims, err := s.readLiveKitToken(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	sum := sha256.Sum256(body)
	if err != nil || claims.Sha256 == "" || !hmac.Equal([]byte(claims.Sha256), []byte(base64.StdEncoding.EncodeToString(sum[:]))) {
		writeFailure(w, store.ErrForbidden)
		return
	}
	var event liveKitEvent
	if err := json.Unmarshal(body, &event); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "The request couldn't be read.")
		return
	}
	if event.Event == "participant_joined" {
		room, identity := event.Room.Name, event.Participant.Identity
		admitted, err := s.admitted(r.Context(), identity, room)
		if err != nil {
			writeFailure(w, err)
			return
		}
		if admitted {
			userID, deviceID, _ := strings.Cut(identity, ".")
			s.voice.pass(userID, deviceID, room)
		}
		// LiveKit sends it again if this fails.
		if !admitted {
			slog.Info("taking someone out of a room that isn't for them")
			if err := s.callLiveKit(r.Context(), room, "RemoveParticipant", map[string]any{"room": room, "identity": identity}); err != nil {
				slog.Warn("taking someone out of a room on the media server", "error", err)
				writeError(w, http.StatusBadGateway, "voice_unavailable", "The media server isn't answering.")
				return
			}
		}
	}
	writeOK(w)
}
