package db

import (
	"context"
	"database/sql"
	"zuna-server/config"
	"zuna-server/ent"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/rs/zerolog/log"
)

var EntClient *ent.Client

func NewClient(ctx context.Context) *ent.Client {
	databaseUrl := config.BuildDatabaseUrl()

	if config.Config.DatabaseType == "mysql" {
		client, err := ent.Open("mysql", databaseUrl)
		if err != nil {
			log.Fatal().Err(err).Msg("failed opening mysql connection")
		}
		return client
	}

	if config.Config.DatabaseType == "sqlite" {
		db, err := sql.Open("sqlite", databaseUrl)
		if err != nil {
			log.Fatal().Err(err).Msg("failed opening sqlite connection")
		}

		db.SetMaxOpenConns(1)
		if _, err := db.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
			log.Fatal().Err(err).Msg("failed enabling sqlite foreign keys")
		}

		if _, err := db.ExecContext(ctx, "PRAGMA journal_mode = WAL"); err != nil {
			log.Fatal().Err(err).Msg("failed enabling sqlite WAL mode")
		}

		if _, err := db.ExecContext(ctx, "PRAGMA busy_timeout = 5000"); err != nil {
			log.Fatal().Err(err).Msg("failed setting sqlite busy timeout")
		}

		drv := entsql.OpenDB(dialect.SQLite, db)
		return ent.NewClient(ent.Driver(drv))
	}

	log.Fatal().Msg("invalid database type, supported: mysql, sqlite")
	return nil
}
