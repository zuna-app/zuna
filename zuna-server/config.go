package main

import (
	"errors"
	"os"

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

type Configuration struct {
	MySQL MySQLConfig `toml:"mysql"`
}

var Config = Configuration{
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
}

func LoadConfig() error {
	data, err := os.ReadFile(CONFIG_PATH)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return SaveDefaultConfig()
		}
		return err
	}

	if err := toml.Unmarshal(data, &Config); err != nil {
		return err
	}

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
