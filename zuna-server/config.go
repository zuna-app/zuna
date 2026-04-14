package main

import (
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

const CONFIG_PATH = "config.toml"

type MySQLConfig struct {
	Host       string   `toml:"host"`
	Port       int      `toml:"port"`
	Username   string   `toml:"username"`
	Password   string   `toml:"password"`
	Database   string   `toml:"database"`
	Parameters []string `toml:"parameters"`
}

type SQLiteConfig struct {
	Database string `toml:"database"`
}

type ServerConfig struct {
	Name string `toml:"name"`
	Logo string `toml:"logo"`
}

type Configuration struct {
	DatabaseType string       `toml:"database_type"`
	MySQL        MySQLConfig  `toml:"mysql"`
	SQLite       SQLiteConfig `toml:"sqlite"`
	Server       ServerConfig `toml:"server"`
}

var Config = Configuration{
	DatabaseType: "mysql",
	MySQL: MySQLConfig{
		Host:     "127.0.0.1",
		Port:     3306,
		Username: "root",
		Password: "",
		Database: "zuna",
		Parameters: []string{
			"parseTime=true",
		},
	},
	SQLite: SQLiteConfig{
		Database: "zuna",
	},
	Server: ServerConfig{
		Name: "Example Zuna server",
		Logo: "logo.png",
	},
}

var ServerLogoBase64 string

func LoadConfig() error {
	data, err := os.ReadFile(CONFIG_PATH)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			err := SaveDefaultConfig()
			if err != nil {
				return err
			}

			return errors.New("generated config, fill values and start server again")
		}
		return err
	}

	if err := toml.Unmarshal(data, &Config); err != nil {
		return err
	}

	if Config.DatabaseType != "mysql" && Config.DatabaseType != "sqlite" {
		return errors.New("invalid database type, supported: mysql, sqlite")
	}

	logoData, err := os.ReadFile(Config.Server.Logo)
	if err != nil {
		return errors.New("could not load server logo")
	}

	ServerLogoBase64 = base64.StdEncoding.EncodeToString(logoData)
	return nil
}

func SaveDefaultConfig() error {
	if _, err := os.Stat(CONFIG_PATH); err == nil {
		return nil
	}

	data, err := toml.Marshal(Config)
	if err != nil {
		return err
	}

	return os.WriteFile(CONFIG_PATH, data, 0644)
}

func BuildDatabaseUrl() string {
	if Config.DatabaseType == "mysql" {
		return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?%s",
			Config.MySQL.Username, Config.MySQL.Password, Config.MySQL.Host,
			Config.MySQL.Port, Config.MySQL.Database, strings.Join(Config.MySQL.Parameters, "&"))
	}

	// _fk=1 is required for foreign keys support
	return fmt.Sprintf("file:%s.db?_fk=1", Config.SQLite.Database)
}
