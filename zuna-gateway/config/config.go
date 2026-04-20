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

type Configuration struct {
	Limits  LimitsConfig  `toml:"limits" comment:"Limits for various server parameters"`
	Gateway GatewayConfig `toml:"gateway" comment:"Gateway server configuration"`
}

type GatewayConfig struct {
	BindAddress string `toml:"bind_address"`
	Port        int    `toml:"port"`
	Password    string `toml:"password" comment:"Password for authenticating servers"`
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
		Port:        8080,
		Password:    "1234",
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
