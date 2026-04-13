package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"zuna-server/ent"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/labstack/echo/v5"

	_ "github.com/go-sql-driver/mysql"
	_ "modernc.org/sqlite"
)

const ZunaAsciiArt = ` _____                 
|__  /   _ _ __   __ _ 
  / / | | | '_ \ / _` + "`" + ` |
 / /| |_| | | | | (_| |
/____\__,_|_| |_|\__,_|
`

var EntClient *ent.Client

type ErrorResponse struct {
	Code  int    `json:"code"`
	Error string `json:"error"`
}

var InternalServerError = ErrorResponse{Code: 500, Error: "internal server error"}
var BadRequest = ErrorResponse{Code: 400, Error: "bad request"}

func main() {
	fmt.Println(ZunaAsciiArt)

	if err := LoadConfig(); err != nil {
		panic(err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	EntClient = NewClient(ctx)
	defer EntClient.Close()

	if err := EntClient.Schema.Create(ctx); err != nil {
		log.Fatalf("failed creating schema resources: %v", err)
	}

	e := echo.New()
	e.Binder = &StrictBinder{}

	e.GET("/", func(c *echo.Context) error {
		return c.String(http.StatusOK, "Hello, World!")
	})

	api := e.Group("/api")

	auth := api.Group("/auth")
	auth.POST("/handshake", authHandshakeEndpoint)
	auth.POST("/auth", authAuthorizeEndpoint)
	auth.POST("/join", authJoinEndpoint)

	chat := api.Group("/chat", authMiddleware)
	chat.GET("/list", chatListEndpoint)

	if err := e.Start(":8080"); err != nil {
		slog.Error("failed to start server", "error", err)
	}
}

func NewClient(ctx context.Context) *ent.Client {
	databaseUrl := BuildDatabaseUrl()

	if Config.DatabaseType == "mysql" {
		client, err := ent.Open("mysql", databaseUrl)
		if err != nil {
			log.Fatalf("failed opening mysql: %v", err)
		}
		return client
	}

	if Config.DatabaseType == "sqlite" {
		db, err := sql.Open("sqlite", databaseUrl)
		if err != nil {
			log.Fatalf("failed opening sqlite: %v", err)
		}

		if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
			log.Fatalf("failed enabling foreign keys: %v", err)
		}

		drv := entsql.OpenDB(dialect.SQLite, db)
		return ent.NewClient(ent.Driver(drv))
	}

	panic("invalid database type, supported: mysql, sqlite")
}
