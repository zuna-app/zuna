// Package api implements Zuna's HTTP and WebSocket interface.
//
// The server is a delivery service and a blob store. It authenticates accounts,
// orders each group's commits and relays ciphertext. It never handles message
// content or message keys.
package api

import (
	"context"
	"crypto/sha256"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"

	"zuna/server/internal/clientip"
	"zuna/server/internal/emotes"
	"zuna/server/internal/ratelimit"
	"zuna/server/internal/store"
)

const (
	// What one JSON request may hold. A commit carries a whole group's tree, and
	// a vault upload many keys; nothing else comes close to these.
	maxJSONBody = 1 << 20
	// A commit and its welcome each carry the group's whole tree, several kilobytes a device
	// with hybrid keys (docs/POST_QUANTUM.md): this takes a group of about two thousand.
	maxCommitBody = 64 << 20
	maxVaultBody  = 4 << 20
	maxSignInBody = 8 << 10
	// A sign-up carries hybrid keys and signatures, and slots sealed with X-Wing, a few
	// kilobytes each (docs/POST_QUANTUM.md).
	maxSignUpBody = 256 << 10
	// What a sign-up may put in the vault: its manifest, and room to spare.
	maxSignUpItems = 4
	// A profile or a group's details: a few short texts and a picture's reference.
	maxDetailsBody = 64 << 10
	maxDetailBytes = 16 << 10
	// An account's vault core: its hybrid keys and the public halves of its slots, and
	// older keys, which each rotation adds to.
	maxVaultCoreBytes = 64 << 10
	// X-Wing's public key, ML-KEM-768's 1,184 bytes and X25519's 32: slots', devices' seal
	// keys and accounts' HPKE keys, as the clients' crypto/src/primitives.rs makes them.
	hpkePublicSize = 1216

	defaultUploadMB = 100
	// A person's files together, if the server doesn't say otherwise.
	defaultUserQuotaMB = 10 << 10
	unattachedTTL      = 24 * time.Hour
	// An upload that has stopped, with nothing arriving for this long.
	abandonedUploadTTL = 6 * time.Hour
	emoteRefresh       = 6 * time.Hour
	emoteRetry         = time.Minute
	cleanupInterval    = time.Hour
	// How often disappearing messages that are due are removed.
	expiryInterval = time.Minute
	// Friends behind one home router share an address, so this allows a burst.
	defaultAuthBurst = 20
	// How long a request's body may take. A part of a file gets longer, on a slow connection,
	// and so does any body allowed past maxJSONBody, such as a commit to a large group.
	ReadTimeout      = time.Minute
	chunkReadTimeout = 10 * time.Minute
	// How long an answer may take to go out, so that a client that stops reading can't
	// hold its handler and socket for ever. Long enough for a page of a group's changes,
	// which can run to megabytes, on a slow connection.
	WriteTimeout = 10 * time.Minute
)

// Config is the part of the server's configuration the API needs.
type Config struct {
	DataDir   string
	PublicURL string
	Version   string
	// TrustProxy takes callers' addresses from X-Forwarded-For when the
	// connection comes from this machine or a private network.
	TrustProxy bool
	// TrustedProxies replaces those networks with exactly these, as addresses or
	// CIDR ranges, for a reverse proxy elsewhere.
	TrustedProxies []string
	// BehindCloudflare takes a request from Cloudflare's proxy to be from whoever
	// it names in CF-Connecting-IP.
	BehindCloudflare bool
	// DownloadURL is where invite pages send people who need the app.
	DownloadURL string
	// AuthBurst is how many sign-in attempts one address can make at once.
	AuthBurst int
	// UserQuotaMB limits one person's files together. Zero is the default, and negative none.
	UserQuotaMB int
	// MinFreeDiskMB is how much of the disk uploads leave free. Zero is the default, and negative no limit.
	MinFreeDiskMB int
	// PushRelays are the relays this server sends notifications through, by
	// address. Phones register with one of them; none turns pushes off.
	PushRelays []string
	// LiveKitURL is the media server voice channels use, as apps reach it. Left
	// empty with LiveKitInternalURL set, apps reach it through this server, at /livekit.
	// Without either, voice channels can be made but not joined.
	LiveKitURL string
	// LiveKitInternalURL is how this server reaches it, if that's not the same.
	LiveKitInternalURL string
	LiveKitKey         string
	LiveKitSecret      string
	// VoiceGrace replaces how long a device that lost its socket stays in a voice channel.
	VoiceGrace time.Duration
	// CallRing replaces how long a call rings before it counts as missed.
	CallRing time.Duration
	// PushWait replaces how long a phone's notification waits while its person is on another device.
	PushWait time.Duration
	// PushHold replaces how long every notification waits, so that its sender's own read cancels theirs.
	PushHold time.Duration
	// PresenceLinger replaces how long someone shows as online after they stop using Zuna.
	PresenceLinger time.Duration
	// TokenScale multiplies how many tokens a person or a bot may be issued in a period. Zero is once.
	TokenScale int
	// Unlimited takes away the limits on how often anyone may ask for anything, for tests that
	// make one request a great many times. A server never sets it.
	Unlimited bool
}

type Server struct {
	cfg     Config
	db      *store.DB
	hub     *Hub
	files   string
	emotes  *emotes.Service
	callers *clientip.Resolver

	authLimiter *ratelimit.Keyed
	// Sealed requests name nobody, so they're held by address alone, as typing is
	// in each group too. What's kept is held by tokens.
	sealedLimiter   *ratelimit.Keyed
	typingLimiter   *ratelimit.Keyed
	writeLimiter    *ratelimit.Keyed
	readLimiter     *ratelimit.Keyed
	emoteLimiter    *ratelimit.Keyed
	socketLimiter   *ratelimit.Keyed
	publicLimiter   *ratelimit.Keyed
	pageLimiter     *ratelimit.Keyed
	claimLimiter    *ratelimit.Keyed
	targetLimiter   *ratelimit.Keyed
	rotateLimiter   *ratelimit.Keyed
	signInFailures  *ratelimit.Backoff
	accountAttempts *ratelimit.Backoff

	// How many reports each person sends, and whom they've reported today, kept
	// in memory alone.
	reportLimiter       *ratelimit.Keyed
	reportTargetLimiter *ratelimit.Keyed

	commitLimiter     *ratelimit.Keyed
	userCommitLimiter *ratelimit.Keyed
	voidLimiter       *ratelimit.Keyed
	commitHolds       *ratelimit.Backoff

	proofs seenProofs

	voice        *voiceRooms
	voiceLimiter *ratelimit.Keyed
	soundLimiter *ratelimit.Keyed
	watchLimiter *ratelimit.Keyed
	liveKit      *http.Client

	// work counts the sockets and background loops the server waits for when it stops,
	// once stopping is set, so that the database isn't closed under them.
	workMu   sync.Mutex
	work     sync.WaitGroup
	stopping bool

	pushClient *http.Client
	// One queue for each sender, and a phone's pushes always in the same one.
	pushQueues [pushConcurrency]chan pushJob
	pushers    sync.Once
	// How many pushes are waiting or on their way, and until when (Unix ms) one the
	// relay doesn't take is given up at once.
	pushing     atomic.Int64
	pushTrouble atomic.Int64
	notified    notifiedChats
	waiting     waitingPushes
	rings       ringPushes
}

// New makes a server. A trusted proxy that can't be read is a mistake in the
// configuration, which the caller should have checked with clientip.New.
func New(cfg Config, db *store.DB) *Server {
	if cfg.AuthBurst <= 0 {
		cfg.AuthBurst = defaultAuthBurst
	}
	if cfg.TokenScale <= 0 {
		cfg.TokenScale = 1
	}
	if cfg.UserQuotaMB == 0 {
		cfg.UserQuotaMB = defaultUserQuotaMB
	}
	if cfg.MinFreeDiskMB == 0 {
		cfg.MinFreeDiskMB = defaultMinFreeDiskMB
	}
	callers, err := clientip.New(cfg.TrustProxy, cfg.TrustedProxies, cfg.BehindCloudflare)
	if err != nil {
		panic(err)
	}
	keyed := func(limit rate.Limit, burst int) *ratelimit.Keyed {
		if cfg.Unlimited {
			limit = rate.Inf
		}
		return ratelimit.NewKeyed(limit, burst)
	}
	s := &Server{
		cfg:         cfg,
		db:          db,
		hub:         newHub(db, cfg.PresenceLinger),
		files:       filepath.Join(cfg.DataDir, "files"),
		emotes:      emotes.New(db, filepath.Join(cfg.DataDir, "emotes")),
		callers:     callers,
		authLimiter: keyed(rate.Every(6*time.Second), cfg.AuthBurst),
		// Friends behind one home router share an address, and a bot may answer in many
		// chats at once, so this only stops a flood.
		sealedLimiter: keyed(rate.Limit(50), 500),
		typingLimiter: keyed(rate.Limit(2), 10),
		// Far beyond what using the app needs, even while uploading a large file.
		writeLimiter: keyed(rate.Limit(50), 300),
		// Reads too, some of which load every user and device, so that one person
		// can't keep the server busy. Catching up after a month, or fetching a large
		// file, stays well inside them.
		readLimiter: keyed(rate.Limit(100), 2000),
		// Apps fetch a server's whole emote set at once, by address, signed in or not.
		emoteLimiter:  keyed(rate.Limit(100), 3000),
		socketLimiter: keyed(rate.Limit(2), 60),
		publicLimiter: keyed(rate.Limit(5), 60),
		pageLimiter:   keyed(rate.Limit(20), 200),
		claimLimiter:  keyed(rate.Limit(5), 600),
		targetLimiter: keyed(rate.Every(2*time.Second), 20),
		// Each rotation is a link for every contact to follow, so they stay rare.
		rotateLimiter:   keyed(rate.Every(time.Minute), 30),
		signInFailures:  ratelimit.NewBackoff(signInFreeFailures, signInFirstWait, signInLongestWait),
		accountAttempts: ratelimit.NewBackoff(accountFreeAttempts, signInFirstWait, accountLongestWait),
		// Per person in a group. The burst is less than store.UndoableCommits, so that
		// what one person sends in one go can always be undone by anyone else.
		commitLimiter:     keyed(rate.Limit(1), 30),
		userCommitLimiter: keyed(rate.Limit(5), 300),
		voidLimiter:       keyed(rate.Every(10*time.Second), 5),
		commitHolds:       ratelimit.NewBackoff(0, time.Minute, time.Hour),
		voice:             newVoiceRooms(),
		voiceLimiter:      keyed(rate.Limit(1), 20),
		soundLimiter:      keyed(rate.Every(2*time.Second), 2), // Plenty to be heard.
		// The apps send four seeks a second at most, while someone drags, and answer those who come in.
		watchLimiter: keyed(rate.Limit(8), 40),
		liveKit:      &http.Client{Timeout: liveKitTimeout},
		pushClient:   &http.Client{Timeout: pushTimeout},

		reportLimiter:       keyed(rate.Every(time.Hour), 10),
		reportTargetLimiter: keyed(rate.Every(24*time.Hour), 1),
	}
	for i := range s.pushQueues {
		s.pushQueues[i] = make(chan pushJob, pushQueueLength)
	}
	db.OnLog(s.tellLog)
	s.restoreSignInAttempts(context.Background())
	s.restoreNotified(context.Background())
	return s
}

// Emotes exposes the emote service, so tests can point it at a fake 7TV.
func (s *Server) Emotes() *emotes.Service { return s.emotes }

// quotaBytes is what one person may keep here, or zero for no limit.
func (s *Server) quotaBytes() int64 {
	if s.cfg.UserQuotaMB < 0 {
		return 0
	}
	return int64(s.cfg.UserQuotaMB) << 20
}

// vaultQuotaBytes is more than that, since the vault counts towards the same total:
// someone with no room for more messages should still keep the keys to the old ones.
func (s *Server) vaultQuotaBytes() int64 {
	return 2 * s.quotaBytes()
}

// EnsureSetupInvite creates the one-time owner invite for an unclaimed server.
func (s *Server) EnsureSetupInvite(ctx context.Context) (string, error) {
	hasOwner, err := s.db.HasOwner(ctx)
	if err != nil || hasOwner {
		return "", err
	}
	code, err := s.db.SetupInvite(ctx)
	if err != nil || code != "" {
		return code, err
	}
	code = randomToken(18)
	if err := s.db.CreateInvite(ctx, code, "", "owner", 1, nil); err != nil {
		return "", err
	}
	return code, nil
}

// RunBackground runs periodic maintenance until ctx ends.
// track counts a piece of work Wait waits for, unless the server is stopping already.
func (s *Server) track() bool {
	s.workMu.Lock()
	defer s.workMu.Unlock()
	if s.stopping {
		return false
	}
	s.work.Add(1)
	return true
}

// CloseSockets closes every socket with a close frame and takes no more, for
// http.Server.RegisterOnShutdown, since Shutdown leaves hijacked connections alone.
func (s *Server) CloseSockets() {
	s.hub.CloseAll()
}

// Wait waits, until ctx ends, for the sockets and the background loops to finish, so
// that the database can be closed after. The loops end with RunBackground's context.
func (s *Server) Wait(ctx context.Context) {
	s.workMu.Lock()
	s.stopping = true
	s.workMu.Unlock()
	done := make(chan struct{})
	go func() {
		s.work.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
	// Even once the wait is over, before the database closes.
	pushes, sent := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Second)
	defer sent()
	s.finishPushes(pushes)
	seeOff, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	s.hub.seeOff(seeOff)
}

// Handler returns the server's complete HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public
	mux.HandleFunc("GET /{$}", s.pageLimited(s.handleHome))
	mux.HandleFunc("GET /invite/{code}", s.publicLimited(s.handleInvitePage))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	mux.HandleFunc("GET /api/info", s.pageLimited(s.handleInfo))
	// The keys tokens are issued under, which everyone is shown alike, asked without a session.
	mux.HandleFunc("GET /api/tokens/keys", s.pageLimited(s.handleTokenKeys))
	mux.HandleFunc("GET /api/icon", s.pageLimited(s.handleIcon))
	mux.HandleFunc("GET /api/invites/{code}", s.publicLimited(s.handleInviteInfo))
	mux.HandleFunc("GET /api/emotes/{id}/{file}", func(w http.ResponseWriter, r *http.Request) {
		if !s.emoteLimiter.Allow(s.callerKey(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Please wait a moment and try again.")
			return
		}
		s.emotes.ServeImage(w, r, r.PathValue("id"), r.PathValue("file"))
	})
	mux.HandleFunc("GET /api/ws", s.handleWebSocket)

	// Accounts
	mux.HandleFunc("POST /api/auth/prelogin", s.limited(s.handlePrelogin))
	mux.HandleFunc("POST /api/auth/register", s.limited(s.handleRegister))
	mux.HandleFunc("POST /api/auth/login", s.limited(s.handleLogin))
	mux.HandleFunc("POST /api/auth/recover", s.limited(s.handleRecover))
	// A session without a device can only finish a recovery, register its device or sign out.
	mux.HandleFunc("POST /api/auth/logout", s.authed(s.handleLogout))

	// Users and devices
	mux.HandleFunc("GET /api/users", s.withDevice(s.handleUsers))
	mux.HandleFunc("GET /api/users/{id}", s.withDevice(s.handleUser))
	mux.HandleFunc("PATCH /api/me", s.withDevice(s.handleUpdateMe))
	mux.HandleFunc("POST /api/devices", s.authed(s.handleAddDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", s.withDevice(s.proven(s.handleRevokeDevice)))
	mux.HandleFunc("PUT /api/push", s.withDevice(s.handleSetPush))
	mux.HandleFunc("DELETE /api/push", s.withDevice(s.handleDeletePush))
	mux.HandleFunc("GET /api/push/notified", s.withDevice(s.handleNotified))
	mux.HandleFunc("GET /api/key-packages/status", s.withDevice(s.handleKeyPackageStatus))
	mux.HandleFunc("POST /api/key-packages", s.withDevice(s.handleAddKeyPackages))
	mux.HandleFunc("POST /api/users/{id}/key-packages/claim", s.withDevice(s.handleClaimKeyPackages))
	// Tokens, counted against whoever asks, which pay for what's sealed without a name
	mux.HandleFunc("POST /api/tokens", s.withDevice(s.handleIssueTokens))

	// Encrypted per-user key vault
	mux.HandleFunc("GET /api/vault", s.withDevice(s.handleVaultGet))
	mux.HandleFunc("PUT /api/vault", s.withDevice(s.proven(s.handleVaultPut)))
	mux.HandleFunc("GET /api/vault/older", s.withDevice(s.handleVaultOlder))
	mux.HandleFunc("POST /api/vault/reseal", s.withDevice(s.proven(s.handleVaultReseal)))
	mux.HandleFunc("GET /api/history-grants", s.withDevice(s.handleHistoryGrants))
	mux.HandleFunc("DELETE /api/history-grants/{id}", s.withDevice(s.handleDeleteHistoryGrant))

	// Generations of an account's keys.
	mux.HandleFunc("GET /api/account", s.withDevice(s.handleAccount))
	mux.HandleFunc("DELETE /api/account", s.withDevice(s.proven(s.handleDeleteAccount)))
	mux.HandleFunc("POST /api/account/rotate", s.withDevice(s.proven(s.handleRotate)))
	mux.HandleFunc("POST /api/account/bundles", s.withDevice(s.proven(s.handleBundles)))
	mux.HandleFunc("POST /api/account/core", s.withDevice(s.proven(s.handleCloseGeneration)))
	mux.HandleFunc("PUT /api/devices/{id}/seal-key", s.withDevice(s.proven(s.handleSealKey)))
	mux.HandleFunc("PUT /api/devices/{id}/certificate", s.withDevice(s.proven(s.handleCertificate)))
	mux.HandleFunc("GET /api/users/{id}/identity-links", s.withDevice(s.handleIdentityLinks))

	// The log of who holds which keys, which every device reads all of (log.go). A device
	// signing in reads it before it registers, with its own account's entries.
	mux.HandleFunc("GET /api/log", s.authed(s.handleLog))
	mux.HandleFunc("GET /api/log/bodies", s.withDevice(s.handleLogBodies))

	// Groups
	mux.HandleFunc("GET /api/groups", s.withDevice(s.handleGroups))
	mux.HandleFunc("POST /api/groups", s.withDevice(s.handleCreateGroup))
	mux.HandleFunc("GET /api/groups/{id}", s.member(s.handleGroup))
	mux.HandleFunc("DELETE /api/groups/{id}", s.member(s.provenMember(s.handleDeleteGroup)))
	mux.HandleFunc("POST /api/groups/{id}/commit", s.member(s.handleCommit))
	mux.HandleFunc("POST /api/groups/{id}/void-commits", s.member(s.handleVoidCommits))
	mux.HandleFunc("GET /api/groups/{id}/group-info", s.member(s.handleGroupInfo))
	mux.HandleFunc("PUT /api/groups/{id}/meta", s.member(s.handleGroupMeta))
	mux.HandleFunc("POST /api/groups/{id}/leave", s.member(s.provenMember(s.handleLeave)))
	mux.HandleFunc("PUT /api/groups/{id}/read", s.member(s.handleRead))
	mux.HandleFunc("GET /api/groups/{id}/changes", s.member(s.handleChanges))
	mux.HandleFunc("GET /api/welcomes", s.withDevice(s.handleWelcomes))
	mux.HandleFunc("DELETE /api/welcomes/{id}", s.withDevice(s.handleDeleteWelcome))

	// Channels, which anyone on the server can list and join
	mux.HandleFunc("GET /api/channels", s.withDevice(s.handleChannels))
	mux.HandleFunc("POST /api/channels", s.admin(s.handleCreateChannel))
	mux.HandleFunc("PUT /api/channels/order", s.admin(s.handleOrderChannels))
	mux.HandleFunc("PATCH /api/channels/{id}", s.admin(s.handleUpdateChannel))
	mux.HandleFunc("DELETE /api/channels/{id}", s.admin(s.handleDeleteChannel))
	mux.HandleFunc("POST /api/channels/{id}/join", s.withDevice(s.handleJoinChannel))
	mux.HandleFunc("POST /api/channels/{id}/history-grants", s.member(s.handleChannelHistoryGrant))

	// Voice, through a media server that only ever carries encrypted media
	mux.HandleFunc("POST /api/channels/{id}/voice", s.member(s.handleVoiceToken(false)))
	mux.HandleFunc("POST /api/channels/{id}/voice/screen", s.member(s.handleStartScreen(false)))
	mux.HandleFunc("DELETE /api/channels/{id}/voice/screen", s.member(s.handleStopScreen))
	mux.HandleFunc("POST /api/channels/{id}/voice/users/{user}/disconnect", s.admin(s.handleVoiceDisconnect))
	mux.HandleFunc("PUT /api/channels/{id}/voice/users/{user}/mute", s.admin(s.handleVoiceMute))
	mux.HandleFunc("DELETE /api/channels/{id}/voice/users/{user}/screen", s.admin(s.handleStopScreenOf))
	mux.HandleFunc("POST /api/channels/{id}/voice/sound", s.member(s.handlePlaySound(false)))
	mux.HandleFunc("POST /api/channels/{id}/voice/watch", s.member(s.handleWatch(false)))

	// Calls in direct messages and groups, in rooms of their own on the same media server
	mux.HandleFunc("GET /api/calls", s.withDevice(s.handleCalls))
	mux.HandleFunc("POST /api/groups/{id}/call", s.member(s.handleVoiceToken(true)))
	mux.HandleFunc("POST /api/groups/{id}/call/screen", s.member(s.handleStartScreen(true)))
	mux.HandleFunc("DELETE /api/groups/{id}/call/screen", s.member(s.handleStopScreen))
	mux.HandleFunc("POST /api/groups/{id}/call/ring", s.member(s.handleRing))
	mux.HandleFunc("POST /api/groups/{id}/call/decline", s.member(s.handleDecline))
	mux.HandleFunc("POST /api/groups/{id}/call/sound", s.member(s.handlePlaySound(true)))
	mux.HandleFunc("POST /api/groups/{id}/call/watch", s.member(s.handleWatch(true)))

	if s.cfg.LiveKitURL == "" && s.cfg.LiveKitInternalURL != "" {
		mux.Handle("/livekit/", s.liveKitProxy())
	}

	// Messages
	mux.HandleFunc("GET /api/groups/{id}/messages", s.member(s.handleMessages))
	mux.HandleFunc("GET /api/groups/{id}/messages/{mid}", s.member(s.handleMessage))
	// A group admin deleting someone else's message, which is theirs to check.
	mux.HandleFunc("DELETE /api/groups/{id}/messages/{mid}", s.member(s.provenMember(s.handleDeleteMessage)))
	mux.HandleFunc("GET /api/groups/{id}/pins", s.member(s.handlePins))

	// What a member adds to a conversation, sealed: nothing says who sent it (sealed.go)
	mux.HandleFunc("POST /api/sealed/groups/{id}/messages", s.sealed(s.handleSealedSend))
	mux.HandleFunc("PUT /api/sealed/groups/{id}/messages/{mid}", s.sealed(s.handleSealedEdit))
	mux.HandleFunc("DELETE /api/sealed/groups/{id}/messages/{mid}", s.sealed(s.handleSealedDelete))
	mux.HandleFunc("POST /api/sealed/groups/{id}/messages/{mid}/reactions", s.sealed(s.handleSealedReact))
	mux.HandleFunc("DELETE /api/sealed/groups/{id}/messages/{mid}/reactions/{rid}", s.sealed(s.handleSealedUnreact))
	mux.HandleFunc("PUT /api/sealed/groups/{id}/messages/{mid}/pin", s.sealed(s.handleSealedPin(true)))
	mux.HandleFunc("DELETE /api/sealed/groups/{id}/messages/{mid}/pin", s.sealed(s.handleSealedPin(false)))
	mux.HandleFunc("POST /api/sealed/groups/{id}/typing", s.sealed(s.handleSealedTyping))

	// Files (always encrypted by the client before upload)
	mux.HandleFunc("POST /api/files", s.withDevice(s.handleCreateFile))
	mux.HandleFunc("GET /api/files/{id}", s.withDevice(s.handleFileInfo))
	mux.HandleFunc("PUT /api/files/{id}/chunks/{n}", s.withDevice(s.handleUploadChunk))
	mux.HandleFunc("GET /api/files/{id}/chunks/{n}", s.withDevice(s.handleDownloadChunk))
	mux.HandleFunc("POST /api/files/{id}/complete", s.withDevice(s.handleCompleteFile))

	// Emotes
	mux.HandleFunc("GET /api/emotes", s.withDevice(s.handleEmotes))

	// The soundboard, which admins fill
	mux.HandleFunc("GET /api/sounds", s.withDevice(s.handleSounds))
	mux.HandleFunc("POST /api/sounds", s.admin(s.handleCreateSound))
	mux.HandleFunc("PATCH /api/sounds/{id}", s.admin(s.handleUpdateSound))
	mux.HandleFunc("DELETE /api/sounds/{id}", s.admin(s.handleDeleteSound))

	// Server administration
	mux.HandleFunc("GET /api/invites", s.withDevice(s.handleListInvites))
	mux.HandleFunc("POST /api/invites", s.withDevice(s.proven(s.handleCreateInvite)))
	mux.HandleFunc("DELETE /api/invites/{code}", s.withDevice(s.proven(s.handleRevokeInvite)))
	mux.HandleFunc("PATCH /api/admin/settings", s.admin(s.handleUpdateSettings))
	mux.HandleFunc("PUT /api/admin/icon", s.admin(s.handleUpdateIcon))
	mux.HandleFunc("PUT /api/admin/emote-set", s.admin(s.handleSetEmoteSet))
	mux.HandleFunc("PUT /api/admin/users/{id}/role", s.admin(s.handleSetRole))
	mux.HandleFunc("POST /api/admin/users/{id}/ban", s.admin(s.handleBan))
	mux.HandleFunc("POST /api/admin/users/{id}/unban", s.admin(s.handleUnban))
	mux.HandleFunc("GET /api/admin/bans", s.admin(s.handleBans))

	// Bots: accounts a person here makes and owns, which a program of theirs runs
	mux.HandleFunc("GET /api/bots", s.withDevice(s.handleBots))
	mux.HandleFunc("POST /api/bots", s.withDevice(s.proven(s.handleCreateBot)))
	mux.HandleFunc("PATCH /api/bots/{id}", s.withDevice(s.proven(s.handleUpdateBot)))
	mux.HandleFunc("POST /api/bots/{id}/setup", s.withDevice(s.proven(s.handleBotSetup)))
	mux.HandleFunc("DELETE /api/bots/{id}", s.withDevice(s.proven(s.handleDeleteBot)))
	mux.HandleFunc("PUT /api/bots/{id}/channels", s.admin(s.handleBotChannels))

	// Reporting someone to the server's admins
	mux.HandleFunc("POST /api/reports", s.withDevice(s.handleReport))
	mux.HandleFunc("GET /api/admin/reports", s.admin(s.handleReports))
	mux.HandleFunc("DELETE /api/admin/reports/{id}", s.admin(s.handleDismissReports))

	return s.withMiddleware(mux)
}

// forThisMachine reports whether a request was addressed to a name meaning this machine.
func forThisMachine(r *http.Request) bool {
	name := r.Host
	if host, _, err := net.SplitHostPort(r.Host); err == nil {
		name = host
	}
	name = strings.ToLower(name)
	return name == "localhost" || strings.HasSuffix(name, ".localhost")
}

// response is the writer every handler gets. It holds the request, so that a failure
// can be logged with its route, which the mux fills in on that same request, and
// notes whether anything was written, so that a panic after that writes nothing more.
// Unwrap lets ResponseController, and the WebSocket and LiveKit proxy's hijacking,
// reach the writer underneath.
type response struct {
	http.ResponseWriter
	r       *http.Request
	started bool
}

func (w *response) WriteHeader(status int) {
	w.started = true
	w.ResponseWriter.WriteHeader(status)
}

func (w *response) Write(b []byte) (int, error) {
	w.started = true
	return w.ResponseWriter.Write(b)
}

func (w *response) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(raw http.ResponseWriter, r *http.Request) {
		w := &response{ResponseWriter: raw, r: r}
		// Authentication uses bearer tokens, never cookies, so allowing any
		// origin gives other websites no access. The desktop app needs this
		// because it talks to whichever servers its user has joined.
		headers := w.Header()
		headers.Set("Access-Control-Allow-Origin", "*")
		headers.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		headers.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Zuna-Proof, X-Zuna-Time, X-Zuna-Seal, X-Zuna-Epoch, X-Zuna-Token, X-Zuna-Item")
		headers.Set("Access-Control-Max-Age", "86400")
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("Referrer-Policy", "no-referrer")
		// Behind a proxy there's no telling how a request arrived, but browsers ignore
		// this over plain HTTP. Only for this machine would it stick to something else.
		if !forThisMachine(r) {
			headers.Set("Strict-Transport-Security", "max-age=31536000")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec)
				}
				// The route's pattern, as a path names channels and people.
				slog.Error("handler panic", "method", r.Method, "route", r.Pattern, "panic", rec)
				// Once a response has begun, a second one would only be appended to it.
				if !w.started {
					writeError(w, http.StatusInternalServerError, "internal", "Something went wrong on the server.")
				}
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// --- Auth wrappers ---

type authedHandler func(http.ResponseWriter, *http.Request, *store.Session)
type memberHandler func(http.ResponseWriter, *http.Request, *store.Session, *store.GroupMember)

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func bearerToken(r *http.Request) string {
	return strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
}

func (s *Server) authed(next authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sess, err := s.db.SessionByToken(r.Context(), hashToken(bearerToken(r)))
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthorized", "Please sign in again.")
			return
		}
		if r.Method != http.MethodGet && !s.writeLimiter.Allow(sess.UserID) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many changes at once. Please wait a moment.")
			return
		}
		if r.Method == http.MethodGet && !s.readLimiter.Allow(sess.UserID) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "That's too many requests at once. Please wait a moment.")
			return
		}
		next(w, r, sess)
	}
}

func (s *Server) withDevice(next authedHandler) http.HandlerFunc {
	return s.authed(func(w http.ResponseWriter, r *http.Request, sess *store.Session) {
		if sess.DeviceID == "" {
			writeError(w, http.StatusForbidden, "device_required", "This session has no registered device.")
			return
		}
		next(w, r, sess)
	})
}

func (s *Server) member(next memberHandler) http.HandlerFunc {
	return s.withDevice(func(w http.ResponseWriter, r *http.Request, sess *store.Session) {
		groupID := r.PathValue("id")
		if !store.ValidID(groupID) {
			writeError(w, http.StatusNotFound, "not_found", "That conversation doesn't exist.")
			return
		}
		membership, err := s.db.Membership(r.Context(), groupID, sess.UserID)
		if err != nil {
			writeFailure(w, err)
			return
		}
		next(w, r, sess, membership)
	})
}

func (s *Server) admin(next authedHandler) http.HandlerFunc {
	return s.withDevice(func(w http.ResponseWriter, r *http.Request, sess *store.Session) {
		if !isServerAdmin(sess) {
			writeError(w, http.StatusForbidden, "forbidden", "Only server admins can do this.")
			return
		}
		// Everything an admin does is for the whole server, so it needs the device's proof.
		if r.Method != http.MethodGet && !s.checkProof(w, r, sess) {
			return
		}
		next(w, r, sess)
	})
}

func (s *Server) limited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authLimiter.Allow(s.signInCallerKey(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many attempts. Please wait a minute and try again.")
			return
		}
		next(w, r)
	}
}

// publicLimited is for what anyone may ask without an account, often: far looser
// than signing in, since one invite link may be opened by many people at once.
func (s *Server) publicLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.publicLimiter.Allow(s.callerKey(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Please wait a moment and try again.")
			return
		}
		next(w, r)
	}
}

// pageLimited is for what's open to anyone and takes a few queries to answer. Every
// app asks for these, so this only stops someone doing nothing else.
func (s *Server) pageLimited(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.pageLimiter.Allow(s.callerKey(r)) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "Too many requests. Please wait a moment and try again.")
			return
		}
		next(w, r)
	}
}

// callerKey is who to count a request against when there's no account to go by.
func (s *Server) callerKey(r *http.Request) string {
	return clientip.Key(s.callers.Address(r))
}

// --- Helpers ---
