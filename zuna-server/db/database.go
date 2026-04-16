package db

import (
	"context"
	"database/sql"
	"zuna-server/ent"
	"zuna-server/utils"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/rs/zerolog/log"
)

var EntClient *ent.Client

func NewClient(ctx context.Context) *ent.Client {
	databaseUrl := utils.BuildDatabaseUrl()

	if utils.Config.DatabaseType == "mysql" {
		client, err := ent.Open("mysql", databaseUrl)
		if err != nil {
			log.Fatal().Err(err).Msg("failed opening mysql connection")
		}
		return client
	}

	if utils.Config.DatabaseType == "sqlite" {
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
