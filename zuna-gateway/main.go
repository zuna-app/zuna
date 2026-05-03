package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"
	"zuna-gateway/config"
	"zuna-gateway/crypto"
	"zuna-gateway/rest"
	"zuna-gateway/ws"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"golang.org/x/time/rate"
)

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})

	log.Info().Msg("  _____   _ _  _   _   ")
	log.Info().Msg(" |_  / | | | \\| | /_\\  ")
	log.Info().Msg("  / /| |_| | .` |/ _ \\ ")
	log.Info().Msg(" /___|\\___/|_|\\_/_/ \\_\\")
	log.Info().Msg("                       ")

	if err := config.LoadConfig(); err != nil {
		log.Fatal().Err(err).Msg("failed to load config")
	}

	if err := crypto.LoadServerTLSCertificate(); err != nil {
		log.Fatal().Err(err).Msg("failed to load server TLS certificate")
		return
	}

	if err := crypto.LoadVapidKeypair(); err != nil {
		log.Fatal().Err(err).Msg("failed to load vapid keypair")
		return
	}

	ctx := context.Background()

	e := echo.New()
	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit(config.Config.Limits.MaxRequestSize))
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
	}))
	e.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))

	apiLimiter := rest.NewRateLimiter(
		rate.Limit(config.Config.Limits.NotificationRateLimit),
		config.Config.Limits.NotificationBurstLimit,
		10*time.Minute,
	)

	api := e.Group("/api", apiLimiter.Middleware())
	api.POST("/notification", rest.NotificationEndpoint)
	api.GET("/validate", rest.ValidateEndpoint)
	api.GET("/vapid/public-key", rest.VapidPublicKeyEndpoint)
	api.POST("/push/subscribe", rest.PushSubscribeEndpoint)
	api.POST("/push/unsubscribe", rest.PushUnsubscribeEndpoint)

	ws.HubInstance = ws.NewHub()
	go ws.HubInstance.Run()

	msgRouter := ws.NewMessageRouter(ws.HubInstance)
	e.GET("/ws", ws.HandleWebSocket(ws.HubInstance, msgRouter))

	log.Info().Str("bind-addr", config.Config.Gateway.BindAddress).Int("port", config.Config.Gateway.Port).Msg("starting server")
	sc := echo.StartConfig{
		Address: fmt.Sprintf("%s:%d", config.Config.Gateway.BindAddress, config.Config.Gateway.Port),
	}

	if err := sc.StartTLS(ctx, e, crypto.ServerTLSCertificate, crypto.ServerTLSKey); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, context.Canceled) {
		log.Error().Err(err).Msg("failed to start server")
		return
	}

	log.Info().Msg("shutting down server")
}
