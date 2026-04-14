package main

import (
	"context"
	"database/sql"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"zuna-server/ent"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

var EntClient *ent.Client

type ErrorResponse struct {
	Error string `json:"error"`
}

var (
	InternalServerError = ErrorResponse{Error: "internal server error"}
	BadRequest          = ErrorResponse{Error: "bad request"}
	Unauthorized        = ErrorResponse{Error: "unauthorized"}
	Forbidden           = ErrorResponse{Error: "forbidden"}
)

func main() {
	log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr})

	log.Info().Msg("  _____   _ _  _   _   ")
	log.Info().Msg(" |_  / | | | \\| | /_\\  ")
	log.Info().Msg("  / /| |_| | .` |/ _ \\ ")
	log.Info().Msg(" /___|\\___/|_|\\_/_/ \\_\\")
	log.Info().Msg("                       ")

	if err := LoadConfig(); err != nil {
		log.Fatal().Err(err).Msg("failed to load config")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	EntClient = NewClient(ctx)
	defer EntClient.Close()

	if err := EntClient.Schema.Create(ctx); err != nil {
		log.Fatal().Err(err).Msg("failed creating schema resources")
	}

	e := echo.New()
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
	}))
	e.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))
	e.Binder = &StrictBinder{}

	e.GET("/", func(c *echo.Context) error {
		return c.String(http.StatusOK, "Hello, World!")
	})

	api := e.Group("/api")

	auth := api.Group("/auth")
	auth.POST("/handshake", authHandshakeEndpoint)
	auth.POST("/login", authLoginEndpoint)
	auth.POST("/join", authJoinEndpoint)

	chat := api.Group("/chat", authMiddleware)
	chat.GET("/list", chatListEndpoint)
	chat.GET("/messages", chatMessagesEndpoint)

	// Create the central hub and start it
	h := NewHub()
	go h.Run()

	// Create message router with all handlers registered
	msgRouter := NewMessageRouter(h)
	e.GET("/ws", HandleWebSocket(h, msgRouter))

	log.Info().Any("port", 8080).Msg("starting server")
	if err := e.Start(":8080"); err != nil {
		log.Error().Err(err).Msg("failed to start server")
	}

	<-ctx.Done()
	log.Info().Msg("shutting down server")
}

func NewClient(ctx context.Context) *ent.Client {
	databaseUrl := BuildDatabaseUrl()

	if Config.DatabaseType == "mysql" {
		client, err := ent.Open("mysql", databaseUrl)
		if err != nil {
			log.Fatal().Err(err).Msg("failed opening mysql connection")
		}
		return client
	}

	if Config.DatabaseType == "sqlite" {
		db, err := sql.Open("sqlite", databaseUrl)
		if err != nil {
			log.Fatal().Err(err).Msg("failed opening sqlite connection")
		}

		if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
			log.Fatal().Err(err).Msg("failed enabling sqlite foreign keys")
		}

		drv := entsql.OpenDB(dialect.SQLite, db)
		return ent.NewClient(ent.Driver(drv))
	}

	log.Fatal().Msg("invalid database type, supported: mysql, sqlite")
	return nil
}
