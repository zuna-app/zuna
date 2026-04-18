package rest

import (
	"net/http"
	"regexp"
	"zuna-server/db"
	"zuna-server/ent/user"
	"zuna-server/utils"

	"github.com/rs/zerolog/log"

	"github.com/labstack/echo/v5"
)

type JoinRequest struct {
	Username      string `json:"username"`
	IdentityKey   string `json:"identity_key"`
	SigningKey    string `json:"signing_key"`
	Avatar        string `json:"avatar"`
	AvatarIv      string `json:"avatar_iv"`
	AvatarAuthTag string `json:"avatar_auth_tag"`
}

type JoinResponse struct {
	ID string `json:"id"`
}

var usernameAllowedChars = regexp.MustCompile(`^[A-Za-z0-9]+$`)

func AuthJoinEndpoint(c *echo.Context) error {
	req := new(JoinRequest)
	if err := c.Bind(req); err != nil {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	if len(req.Username) < utils.Config.Server.MinUsernameLength || len(req.Username) > utils.Config.Server.MaxUsernameLength {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "invalid username length"})
	}

	if !usernameAllowedChars.MatchString(req.Username) {
		return c.JSON(http.StatusBadRequest, HttpErrorResponse{Error: "username must contain only letters and numbers"})
	}

	if !utils.ValidateEd25519PublicKey(req.IdentityKey) {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	if !utils.ValidateEd25519PublicKey(req.SigningKey) {
		return c.JSON(http.StatusBadRequest, BadRequest)
	}

	exists, err := db.EntClient.User.Query().Where(user.UsernameEQ(req.Username)).Exist(c.Request().Context())
	if err != nil {
		log.Error().Err(err).Msg("failed to check user existence")
		return c.JSON(http.StatusInternalServerError, InternalServerError)
	}

	if exists {
		return c.JSON(http.StatusConflict, HttpErrorResponse{Error: "username already taken"})
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
		SetAvatarKey("").
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

	return c.JSON(http.StatusOK, JoinResponse{
		ID: u.ID,
	})
}
