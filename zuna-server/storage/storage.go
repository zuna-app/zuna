package storage

import (
	"os"
	"path/filepath"
	"zuna-server/utils"
)

func GetDataByKey(key string) ([]byte, error) {
	storagePath := utils.Config.Server.StorageDirectory + string(filepath.Separator) + key

	data, err := os.ReadFile(storagePath)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func StoreData(key string, data []byte) error {
	storagePath := utils.Config.Server.StorageDirectory + string(filepath.Separator) + key

	err := os.WriteFile(storagePath, data, 0600)
	if err != nil {
		return err
	}
	return nil
}

func DeleteData(key string) error {
	storagePath := utils.Config.Server.StorageDirectory + string(filepath.Separator) + key

	err := os.Remove(storagePath)
	if err != nil {
		return err
	}
	return nil
}
