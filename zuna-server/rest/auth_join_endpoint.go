package rest

import (
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"
	"zuna-server/config"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/user"
	"zuna-server/storage"
	"zuna-server/utils"
	"zuna-server/ws"

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

var usernameAllowedChars = regexp.MustCompile(`^[A-Za-z0-9]+$`)

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

	if !utils.ValidateX25519PublicKey(req.IdentityKey) {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid identity key"})
	}

	if !utils.ValidateEd25519PublicKey(req.SigningKey) {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid signing key"})
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

	for _, ud := range data.GetUserDataSnapshot() {
		if ud.ConnectionID != "" {
			continue
		}

		ws.HubInstance.SendTo(ud.ConnectionID, ws.OutgoingMessage{Type: "user_joined", Payload: map[string]string{}})
	}

	return c.JSON(http.StatusOK, JoinResponse{
		ID:              u.ID,
		ServerID:        config.Config.Server.ServerID,
		ServerPublicKey: utils.ServerPublicKeyBase64,
	})
}
