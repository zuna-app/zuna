package main

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"zuna-gateway/config"
	"zuna-gateway/ws"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
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

	e := echo.New()
	e.Use(middleware.Recover())
	e.Use(middleware.BodyLimit(config.Config.Limits.MaxRequestSize))
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete},
	}))
	e.Logger = slog.New(slog.NewJSONHandler(io.Discard, nil))

	ws.HubInstance = ws.NewHub()
	go ws.HubInstance.Run()

	msgRouter := ws.NewMessageRouter(ws.HubInstance)
	e.GET("/ws", ws.HandleWebSocket(ws.HubInstance, msgRouter))

	log.Info().Str("bind-addr", config.Config.Gateway.BindAddress).Int("port", config.Config.Gateway.Port).Msg("starting server")
	if err := e.Start(fmt.Sprintf("%s:%d", config.Config.Gateway.BindAddress, config.Config.Gateway.Port)); err != nil {
		log.Error().Err(err).Msg("failed to start server")
	}

	log.Info().Msg("shutting down server")
}
