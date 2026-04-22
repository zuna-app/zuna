package config

import (
	"errors"
	"os"

	"github.com/pelletier/go-toml/v2"
)

const ConfigFilePath = "config.toml"

type LimitsConfig struct {
	MaxRequestSize         int64 `toml:"max_request_size" comment:"Maximum size of incoming requests in bytes"`
	WsRateLimit            int   `toml:"ws_rate_limit" comment:"Maximum number of WebSocket messages per second"`
	WsBurstLimit           int   `toml:"ws_burst_limit" comment:"Maximum burst size for WebSocket messages"`
	NotificationRateLimit  int   `toml:"notification_rate_limit" comment:"Maximum number of notifications received from server"`
	NotificationBurstLimit int   `toml:"notification_burst_limit" comment:"Maximum burst size for notifications received from server"`
}

type GatewayConfig struct {
	BindAddress string `toml:"bind_address"`
	Port        int    `toml:"port"`
	Password    string `toml:"password" comment:"Gateway password, strongly recommended for non-public gateways. Server must send it to authenticate notifications."`
}

type TLSConfig struct {
	AutoGenerate  bool   `toml:"auto_generate" comment:"Automatically generate self-signed TLS certificate. If used in production better use domain and free LetsEncrypt certificates and provide your own certificate and key files."`
	PublicAddress string `toml:"public_address" comment:"Public address of server, required if using auto generated certificate"`

	CertFile string `toml:"cert_file" comment:"Path to TLS certificate file"`
	KeyFile  string `toml:"key_file" comment:"Path to TLS key file"`
}

type Configuration struct {
	Limits  LimitsConfig  `toml:"limits" comment:"Limits for various server parameters"`
	Gateway GatewayConfig `toml:"gateway" comment:"Gateway server configuration"`
	TLS     TLSConfig     `toml:"tls" comment:"TLS configuration"`
}

var Config = Configuration{
	Limits: LimitsConfig{
		MaxRequestSize:         8 * 1024,
		WsRateLimit:            4,
		WsBurstLimit:           10,
		NotificationRateLimit:  7,
		NotificationBurstLimit: 80,
	},
	Gateway: GatewayConfig{
		BindAddress: "0.0.0.0",
		Port:        25511,
		Password:    "",
	},
	TLS: TLSConfig{
		AutoGenerate:  true,
		PublicAddress: "1.2.3.4",
		CertFile:      "server_tls_cert.pem",
		KeyFile:       "server_tls_key.pem",
	},
}

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
