package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	"zuna-server/config"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/rest"
	"zuna-server/ws"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
	"golang.org/x/time/rate"

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

	if err := config.LoadConfig(); err != nil {
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
	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit(config.RequestSizeLimit))
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
	}))
	e.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	e.Binder = &rest.StrictBinder{}

	e.GET("/", func(c *echo.Context) error {
		return c.String(http.StatusOK, "Hello, World!")
	})

	// Auth endpoints: 10 requests/minute per IP, burst of 5.
	// These trigger expensive crypto (ed25519) or write new DB rows, so they
	// are kept deliberately tight.
	authLimiter := rest.NewRateLimiter(
		rate.Every(6*time.Second), // 10 req/min
		5,
		10*time.Minute,
	)

	// General API endpoints: 120 requests/minute per IP, burst of 30.
	apiLimiter := rest.NewRateLimiter(
		rate.Every(500*time.Millisecond), // 120 req/min
		30,
		10*time.Minute,
	)

	api := e.Group("/api")

	auth := api.Group("/auth", authLimiter.Middleware())
	auth.POST("/handshake", rest.AuthHandshakeEndpoint)
	auth.POST("/login", rest.AuthLoginEndpoint)
	auth.POST("/join", rest.AuthJoinEndpoint)

	chat := api.Group("/chat", rest.AuthMiddleware, apiLimiter.Middleware())
	chat.GET("/list", rest.ChatListEndpoint)
	chat.GET("/messages", rest.ChatMessagesEndpoint)

	attachment := api.Group("/attachment", rest.AuthMiddleware, apiLimiter.Middleware())
	attachment.PUT("/upload", rest.AttachmentUploadEndpoint)

	h := ws.NewHub()
	go h.Run()

	msgRouter := ws.NewMessageRouter(h)
	e.GET("/ws", ws.HandleWebSocket(h, msgRouter))

	log.Info().Str("bind-addr", config.Config.Server.BindAddress).Int("port", config.Config.Server.Port).Msg("starting server")
	if err := e.Start(fmt.Sprintf("%s:%d", config.Config.Server.BindAddress, config.Config.Server.Port)); err != nil {
		log.Error().Err(err).Msg("failed to start server")
	}

	<-ctx.Done()
	log.Info().Msg("shutting down server")
}
