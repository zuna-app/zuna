package main

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/rest"
	"zuna-server/utils"
	"zuna-server/ws"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})

	log.Info().Msg("  _____   _ _  _   _   ")
	log.Info().Msg(" |_  / | | | \\| | /_\\  ")
	log.Info().Msg("  / /| |_| | .` |/ _ \\ ")
	log.Info().Msg(" /___|\\___/|_|\\_/_/ \\_\\")
	log.Info().Msg("                       ")

	if err := utils.LoadConfig(); err != nil {
		log.Fatal().Err(err).Msg("failed to load config")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db.EntClient = db.NewClient(ctx)
	defer db.EntClient.Close()

	if err := db.EntClient.Schema.Create(ctx); err != nil {
		log.Fatal().Err(err).Str("err", err.Error()).Msg("failed creating schema resources")
		return
	}

	data.InitializeUserManager()

	e := echo.New()
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
	}))
	e.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	e.Binder = &rest.StrictBinder{}

	e.GET("/", func(c *echo.Context) error {
		return c.String(http.StatusOK, "Hello, World!")
	})

	api := e.Group("/api")

	auth := api.Group("/auth")
	auth.POST("/handshake", rest.AuthHandshakeEndpoint)
	auth.POST("/login", rest.AuthLoginEndpoint)
	auth.POST("/join", rest.AuthJoinEndpoint)

	chat := api.Group("/chat", rest.AuthMiddleware)
	chat.GET("/list", rest.ChatListEndpoint)
	chat.GET("/messages", rest.ChatMessagesEndpoint)

	avatar := api.Group("/avatar", rest.AuthMiddleware)
	avatar.GET("/", rest.AvatarGetEndpoint)
	avatar.PUT("/", rest.AvatarSetEndpoint)

	h := ws.NewHub()
	go h.Run()

	msgRouter := ws.NewMessageRouter(h)
	e.GET("/ws", ws.HandleWebSocket(h, msgRouter))

	log.Info().Any("port", 8080).Msg("starting server")
	if err := e.Start(":8080"); err != nil {
		log.Error().Err(err).Msg("failed to start server")
	}

	<-ctx.Done()
	log.Info().Msg("shutting down server")
}
