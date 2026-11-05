// Package storetest gives each test a database of its own in PostgreSQL, for
// running the tests there instead of in SQLite.
package storetest

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/url"
	"os"
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// Postgres is the address of the PostgreSQL database to run tests in, from
// ZUNA_TEST_POSTGRES, or empty for SQLite. Tests make schemas in it and drop them.
func Postgres() string { return os.Getenv("ZUNA_TEST_POSTGRES") }

// Schema is an address for a schema of the test's own in that database, which
// opening the store makes, and which is dropped once the test is over.
func Schema(t testing.TB) string {
	t.Helper()
	address, err := url.Parse(Postgres())
	if err != nil {
		t.Fatal(err)
	}
	name := make([]byte, 8)
	rand.Read(name)
	schema := "zuna_test_" + hex.EncodeToString(name)
	t.Cleanup(func() {
		conn, err := sql.Open("pgx", Postgres())
		if err != nil {
			t.Error(err)
			return
		}
		defer conn.Close()
		if _, err := conn.ExecContext(context.Background(), `DROP SCHEMA IF EXISTS `+schema+` CASCADE`); err != nil {
			t.Error(err)
		}
	})
	query := address.Query()
	query.Set("search_path", schema)
	address.RawQuery = query.Encode()
	return address.String()
}
