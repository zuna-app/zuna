package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

const ConfigFilePath = "config.toml"

type MySQLConfig struct {
	Host       string
	Port       int
	Username   string
	Password   string
	Database   string
	Parameters []string `toml:"parameters" comment:"MySQL connection parameters, in most cases you don't need to change this"`
}

type SQLiteConfig struct {
	DatabaseFile string `toml:"database" comment:"SQLite database file"`
}

type ServerConfig struct {
	BindAddress      string `toml:"bind_address"`
	Port             int    `toml:"port"`
	Password         string `toml:"password" comment:"Optional server password, if set clients will be required to provide this password to connect"`
	Name             string `toml:"name"`
	Logo             string `toml:"logo" comment:"Server logo file"`
	StorageDirectory string `toml:"storage_directory" comment:"Directory for storing attachements and avatars"`
}

type LimitsConfig struct {
	MinUsernameLength int   `toml:"min_username_length" comment:"Minimum username length"`
	MaxUsernameLength int   `toml:"max_username_length" comment:"Maximum username length"`
	MaxMessageSize    int64 `toml:"max_message_size" comment:"Maximum message size in bytes"`
	MaxAvatarSize     int64 `toml:"max_avatar_size" comment:"Maximum avatar size in bytes"`
	MaxAttachmentSize int64 `toml:"max_attachment_size" comment:"Maximum attachment size in bytes"`
}

type SevenTvConfig struct {
	Enabled   bool   `toml:"enabled" comment:"Enable 7TV integration"`
	EmotesSet string `toml:"emotes_set" comment:"7TV emotes set URL"`
}

type GatewayConfig struct {
	Addreess string `toml:"bind_address"`
	Port     int    `toml:"port"`
	Password string `toml:"password" comment:"Gateway password, may be empty for public gateway"`
}

type Configuration struct {
	DatabaseType string        `toml:"database_type" comment:"Type of database to use, supported: mysql, sqlite"`
	MySQL        MySQLConfig   `toml:"mysql" comment:"MySQL specific settings, only used if database_type is set to mysql"`
	SQLite       SQLiteConfig  `toml:"sqlite" comment:"SQLite specific settings, only used if database_type is set to sqlite"`
	SevenTv      SevenTvConfig `toml:"sevenTv" comment:"7TV integration settings, 7TV is popular emotes platform used on Twitch"`
	Server       ServerConfig  `toml:"server" comment:"Zuna server settings"`
	Limits       LimitsConfig  `toml:"limits" comment:"Limits for various server parameters"`
	Gateway      GatewayConfig `toml:"gateway" comment:"Gateway server configuration, required for sending push notification to clients"`
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
		DatabaseFile: "zuna.db",
	},
	Server: ServerConfig{
		BindAddress:      "0.0.0.0",
		Port:             8080,
		Password:         "test1234",
		Name:             "Example Zuna server",
		Logo:             "logo.png",
		StorageDirectory: "storage_data",
	},
	Limits: LimitsConfig{
		MinUsernameLength: 3,
		MaxUsernameLength: 32,
		MaxMessageSize:    8 * 1024,          // 8KB
		MaxAvatarSize:     5 * 1024 * 1024,   // 5MB
		MaxAttachmentSize: 512 * 1024 * 1024, // 512MB
	},
	SevenTv: SevenTvConfig{
		Enabled:   true,
		EmotesSet: "https://7tv.app/emote-sets/01KPH7Q8GRK92MVD9YK1H71FV6",
	},
	Gateway: GatewayConfig{
		Addreess: "http://gateway.zuna.chat",
		Port:     8080,
		Password: "",
	},
}

var ServerLogoData string
var RequestSizeLimit int64

func LoadConfig() error {
	data, err := os.ReadFile(ConfigFilePath)
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

	if Config.DatabaseType == "sqlite" {
		Config.SQLite.DatabaseFile = strings.TrimSuffix(Config.SQLite.DatabaseFile, ".db")
	}

	storageDir := strings.TrimSpace(Config.Server.StorageDirectory)
	if storageDir == "" {
		return errors.New("invalid storage directory")
	}

	logoData, err := os.ReadFile(Config.Server.Logo)
	if err != nil {
		return errors.New("could not load server logo")
	}

	if Config.Limits.MaxAttachmentSize > 512*1024*1024 {
		return errors.New("max attachment size cannot be larger than 512MB")
	}

	ServerLogoData = "data:" + http.DetectContentType(logoData) + ";base64," + base64.StdEncoding.EncodeToString(logoData)
	RequestSizeLimit = max(Config.Limits.MaxMessageSize, Config.Limits.MaxAvatarSize, Config.Limits.MaxAttachmentSize) + 1024*1024

	if Config.SevenTv.Enabled {
		Config.SevenTv.EmotesSet = strings.TrimSuffix(Config.SevenTv.EmotesSet, "/")
		parts := strings.Split(Config.SevenTv.EmotesSet, "/")
		if !strings.HasPrefix(Config.SevenTv.EmotesSet, "https://7tv.app/emote-sets/") {
			return errors.New("invalid 7TV emotes set URL")
		}

		id := parts[len(parts)-1]
		Config.SevenTv.EmotesSet = id
	}

	if _, err := os.Stat(Config.Server.StorageDirectory); os.IsNotExist(err) {
		err := os.MkdirAll(Config.Server.StorageDirectory, 0755)
		if err != nil {
			return err
		}
	}

	return nil
}

func SaveDefaultConfig() error {
	if _, err := os.Stat(ConfigFilePath); err == nil {
		return nil
	}

	data, err := toml.Marshal(Config)
	if err != nil {
		return err
	}

	return os.WriteFile(ConfigFilePath, data, 0644)
}

func BuildDatabaseUrl() string {
	if Config.DatabaseType == "mysql" {
		return fmt.Sprintf("%s:%s@tcp(%s:%d)/%s?%s",
			Config.MySQL.Username, Config.MySQL.Password, Config.MySQL.Host,
			Config.MySQL.Port, Config.MySQL.Database, strings.Join(Config.MySQL.Parameters, "&"))
	}

	// _fk=1 is required for foreign keys support
	return fmt.Sprintf("file:%s.db?_fk=1&_journal_mode=WAL&_busy_timeout=5000", Config.SQLite.DatabaseFile)
}
