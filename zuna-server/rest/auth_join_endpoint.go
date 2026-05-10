package rest

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"

	"zuna.chat/zuna-server/config"
	"zuna.chat/zuna-server/crypto"
	"zuna.chat/zuna-server/data"
	"zuna.chat/zuna-server/db"
	"zuna.chat/zuna-server/ent"
	gochannel "zuna.chat/zuna-server/ent/channel"
	"zuna.chat/zuna-server/ent/groupkey"
	"zuna.chat/zuna-server/ent/user"
	"zuna.chat/zuna-server/storage"
	"zuna.chat/zuna-server/utils"
	"zuna.chat/zuna-server/ws"

	"github.com/nrednav/cuid2"
	"github.com/rs/zerolog/log"

	"github.com/labstack/echo/v5"
)

type JoinRequest struct {
	Username       string `json:"username"`
	IdentityKey    string `json:"identity_key"`
	SigningKey     string `json:"signing_key"`
	Avatar         string `json:"avatar"`
	ServerPassword string `json:"server_password"`
}

type JoinResponse struct {
	ID              string `json:"id"`
	ServerID        string `json:"server_id"`
	ServerPublicKey string `json:"server_public_key"`
}

var usernameAllowedChars = regexp.MustCompile(`^[A-Za-z0-9 ]+$`)

func AuthJoinEndpoint(c *echo.Context) error {
	req := new(JoinRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, InvalidRequest)
	}

	if len(req.Username) < config.Config.Limits.MinUsernameLength || len(req.Username) > config.Config.Limits.MaxUsernameLength {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid username length"})
	}

	if !usernameAllowedChars.MatchString(req.Username) {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "username must contain only letters and numbers"})
	}

	if !utils.ValidateServerPassword(req.ServerPassword) {
		return c.JSON(http.StatusUnauthorized, HttpErrorResponse{Error: "invalid server password"})
	}

	if !crypto.ValidateX25519PublicKey(req.IdentityKey) {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid identity key"})
	}

	if !crypto.ValidateEd25519PublicKey(req.SigningKey) {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid signing key"})
	}

	// Check if a user with this identity key already exists (returning user).
	existingUser, err := db.EntClient.User.Query().Where(user.IdentityKeyEQ(req.IdentityKey)).Only(c.Request().Context())
	if err != nil && !ent.IsNotFound(err) {
		log.Error().Err(err).Msg("failed to check identity key uniqueness")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if existingUser != nil {
		if existingUser.Username != req.Username {
			return c.JSON(http.StatusConflict, HttpErrorResponse{Error: "identity key already registered with a different username"})
		}
		// Same identity key and username - allow rejoin.
		return c.JSON(http.StatusOK, JoinResponse{
			ID:              existingUser.ID,
			ServerID:        config.Config.Server.ServerID,
			ServerPublicKey: crypto.ServerPublicKeyBase64,
		})
	}

	exists, err := db.EntClient.User.Query().Where(user.UsernameEQ(req.Username)).Exist(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to check user existence")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if exists {
		return c.JSON(http.StatusConflict, HttpErrorResponse{Error: "username already taken"})
	}

	avatarKey := ""
	avatarMime := ""

	if req.Avatar != "" {
		if !strings.HasPrefix(req.Avatar, "data:") && !strings.Contains(req.Avatar, "base64,") {
			return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid avatar format"})
		}

		split := strings.Split(req.Avatar, ";")
		if len(split) < 2 {
			return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid avatar format"})
		}

		avatarMime = strings.TrimPrefix(split[0], "data:")
		avatarBase := strings.Replace(split[1], "base64,", "", -1)
		avatarBytes, err := base64.StdEncoding.DecodeString(avatarBase)
		if err != nil {
			return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid avatar data"})
		}

		if len(avatarBytes) == 0 || int64(len(avatarBytes)) > config.Config.Limits.MaxAvatarSize {
			return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "avatar size exceeds limit"})
		}

		avatarKey = cuid2.Generate()
		err = storage.StoreData(avatarKey, avatarBytes)
		if err != nil {
			log.Error().Err(err).Str("username", req.Username).Msg("failed to store avatar")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}
	}

	ctx := c.Request().Context()

	tx, err := db.EntClient.Tx(ctx)
	if err != nil {
		log.Error().Err(err).Msg("failed to begin join transaction")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	u, err := tx.User.Create().
		SetUsername(req.Username).
		SetIdentityKey(req.IdentityKey).
		SetSigningKey(req.SigningKey).
		SetAvatarKey(avatarKey).
		SetAvatarMime(avatarMime).
		Save(ctx)

	if err != nil {
		tx.Rollback()
		log.Error().Err(err).Str("username", req.Username).Msg("failed to create user")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	users, err := tx.User.Query().
		Where(user.IDNEQ(u.ID)).
		All(ctx)
	if err != nil {
		tx.Rollback()
		log.Error().Err(err).Str("username", req.Username).Msg("failed to query existing users")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	for _, other := range users {
		_, err := tx.Chat.Create().
			AddUsers(u, other).
			Save(ctx)
		if err != nil {
			tx.Rollback()
			log.Error().Err(err).Str("username", req.Username).Msg("failed to create chat for new user")
			return c.JSON(http.StatusInternalServerError, InternalServerError)
		}
	}

	if err := tx.Commit(); err != nil {
		log.Error().Err(err).Str("username", req.Username).Msg("failed to commit join transaction")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	// Add new user to all existing public channels and notify online key-holders to redistribute.
	publicChannels, pErr := db.EntClient.Channel.Query().
		Where(gochannel.IsPublic(true)).
		All(ctx)
	if pErr != nil {
		log.Error().Err(pErr).Str("userId", u.ID).Msg("failed to query public channels for new user")
	} else {
		for _, ch := range publicChannels {
			if _, addErr := db.EntClient.ChannelMember.Create().
				SetChannelID(ch.ID).
				SetUserID(u.ID).
				Save(ctx); addErr != nil {
				log.Error().Err(addErr).Str("channelId", ch.ID).Str("userId", u.ID).Msg("failed to add new user to public channel")
				continue
			}

			// Find all online members who have a delivered key and ask them to provide one to the new user.
			membersWithKeys, mkErr := db.EntClient.GroupKey.Query().
				WithRecipient().
				Where(
					groupkey.HasChannelWith(gochannel.IDEQ(ch.ID)),
					groupkey.DeliveredAtNotNil(),
				).
				All(ctx)
			if mkErr != nil {
				log.Error().Err(mkErr).Str("channelId", ch.ID).Msg("failed to query key-holders for redistribution")
				continue
			}

			for _, gk := range membersWithKeys {
				if gk.Edges.Recipient == nil {
					continue
				}
				holderData, holderErr := data.GetUserDataByID(gk.Edges.Recipient.ID)
				if holderErr != nil || !holderData.Active {
					continue
				}
				for _, connID := range holderData.ConnectionIDs {
					ws.HubInstance.SendTo(connID, ws.OutgoingMessage{
						Type: "channel_key_requests",
						Payload: map[string]any{
							"requests": []data.KeyRequestDTO{
								{
									ChannelID:            ch.ID,
									RecipientUserID:      u.ID,
									RecipientIdentityKey: u.IdentityKey,
								},
							},
						},
					})
				}
			}
		}
	}

	for _, ud := range data.GetUserDataSnapshot() {
		if len(ud.ConnectionIDs) == 0 {
			continue
		}

		for _, connectionID := range ud.ConnectionIDs {
			ws.HubInstance.SendTo(connectionID, ws.OutgoingMessage{Type: "user_joined", Payload: map[string]string{}})
		}
	}

	return c.JSON(http.StatusOK, JoinResponse{
		ID:              u.ID,
		ServerID:        config.Config.Server.ServerID,
		ServerPublicKey: crypto.ServerPublicKeyBase64,
	})
}
