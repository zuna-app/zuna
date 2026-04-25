package storage

import (
	"os"

	"zuna.chat/zuna-server/config"

	securejoin "github.com/cyphar/filepath-securejoin"
)

func GetDataByKey(key string) ([]byte, error) {
	storagePath, err := securejoin.SecureJoin(config.Config.Server.StorageDirectory, key + ".bin")
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(storagePath)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func StoreData(key string, data []byte) error {
	storagePath, err := securejoin.SecureJoin(config.Config.Server.StorageDirectory, key + ".bin")
	if err != nil {
		return err
	}

	err = os.WriteFile(storagePath, data, 0600)
	if err != nil {
		return err
	}
	return nil
}

func DeleteData(key string) error {
	if key == "" {
		return nil
	}

	storagePath, err := securejoin.SecureJoin(config.Config.Server.StorageDirectory, key + ".bin")
	if err != nil {
		return err
	}

	err = os.Remove(storagePath)
	if err != nil {
		return err
	}
	return nil
}
