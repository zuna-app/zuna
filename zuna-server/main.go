package main

import (
	"context"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"strings"
	"zuna-server/ent"

	"github.com/labstack/echo/v5"

	_ "github.com/go-sql-driver/mysql"
)

var EntClient *ent.Client

type ErrorResponse struct {
	Code  int    `json:"code"`
	Error string `json:"error"`
}

var InternalServerError = ErrorResponse{Code: 500, Error: "internal server error"}
var BadRequest = ErrorResponse{Code: 400, Error: "bad request"}

func main() {
	err := LoadConfig()
	if err != nil {
		panic(err)
	}

	connectionUrl := fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?%s",
		Config.MySQL.Username, Config.MySQL.Password, Config.MySQL.Host,
		Config.MySQL.Port, Config.MySQL.Database, strings.Join(Config.MySQL.Parameters, "&"))

	client, err := ent.Open("mysql", connectionUrl)
	if err != nil {
		log.Fatalf("failed opening connection to mysql: %v", err)
	}

	EntClient = client
	defer client.Close()
	ctx := context.Background()
	if err := client.Schema.Create(ctx); err != nil {
		log.Fatalf("failed creating schema resources: %v", err)
	}

	e := echo.New()
	e.GET("/", func(c *echo.Context) error {
		return c.String(http.StatusOK, "Hello, World!")
	})

	e.POST("/handshake", handshakeEndpoint)
	e.POST("/auth", authEndpoint)
	e.GET("/test", testEndpoint, authMiddleware)

	if err := e.Start(":8080"); err != nil {
		slog.Error("failed to start server", "error", err)
	}

}
