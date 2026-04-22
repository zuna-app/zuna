package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/nrednav/cuid2"
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
	ServerID         string `toml:"server_id" comment:"Automatically generated unique server ID, never change this value"`
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
	Address         string `toml:"address"`
	Password        string `toml:"password" comment:"Gateway password, may be empty for public gateway"`
	AllowSelfSigned bool   `toml:"allow_self_signed" comment:"Allow self-signed TLS certificate for gateway connection"`
}

type LiveKitConfig struct {
	Enabled   bool   `toml:"enabled" comment:"Enable LiveKit (self-hosted) - required for calls and screen sharing"`
	ApiKey    string `toml:"api_key" comment:"LiveKit API key - same as in LiveKit configuration"`
	ApiSecret string `toml:"api_secret" comment:"LiveKit API secret - same as in LiveKit configuration"`
	Address   string `toml:"url" comment:"LiveKit server address - in most cases your public server public IP"`
	Port      int    `toml:"port" comment:"LiveKit server port - same as in LiveKit configuration"`
}

type TLSConfig struct {
	AutoGenerate  bool   `toml:"auto_generate" comment:"Automatically generate self-signed TLS certificate. If used in production better use domain and free LetsEncrypt certificates and provide your own certificate and key files."`
	PublicAddress string `toml:"public_address" comment:"Public address of server, required if using auto generated certificate"`

	CertFile string `toml:"cert_file" comment:"Path to TLS certificate file"`
	KeyFile  string `toml:"key_file" comment:"Path to TLS key file"`
}

type Configuration struct {
	DatabaseType string        `toml:"database_type" comment:"Type of database to use, supported: mysql, sqlite"`
	MySQL        MySQLConfig   `toml:"mysql" comment:"MySQL specific settings, only used if database_type is set to mysql"`
	SQLite       SQLiteConfig  `toml:"sqlite" comment:"SQLite specific settings, only used if database_type is set to sqlite"`
	SevenTv      SevenTvConfig `toml:"sevenTv" comment:"7TV integration settings, 7TV is popular emotes platform used on Twitch"`
	Server       ServerConfig  `toml:"server" comment:"Zuna server settings"`
	LiveKit      LiveKitConfig `toml:"livekit" comment:"LiveKit settings, required for calls and screen sharing"`
	Limits       LimitsConfig  `toml:"limits" comment:"Limits for various server parameters"`
	Gateway      GatewayConfig `toml:"gateway" comment:"Gateway server configuration, required for sending push notification to clients"`
	TLS          TLSConfig     `toml:"tls" comment:"TLS configuration"`
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
		Port:             25510,
		Password:         "test1234",
		Name:             "Example Zuna server",
		Logo:             "logo.png",
		StorageDirectory: "storage_data",
		ServerID:         cuid2.Generate(),
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
		EmotesSet: "global",
	},
	Gateway: GatewayConfig{
		Address:         "gateway.zuna.chat:25511",
		Password:        "",
		AllowSelfSigned: false,
	},
	LiveKit: LiveKitConfig{
		Enabled:   false,
		ApiKey:    "",
		ApiSecret: "",
		Address:   "",
		Port:      7880,
	},
	TLS: TLSConfig{
		AutoGenerate:  true,
		PublicAddress: "1.2.3.4",
		CertFile:      "server_tls_cert.pem",
		KeyFile:       "server_tls_key.pem",
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
