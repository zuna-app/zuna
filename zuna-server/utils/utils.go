package utils

import (
	"zuna.chat/zuna-server/config"
	"zuna.chat/zuna-server/ent"
)

func ValidateServerPassword(password string) bool {
	if config.Config.Server.Password == "" {
		return true
	}

	return password == config.Config.Server.Password
}

func IsMember(userID string, members []*ent.User) bool {
	for _, m := range members {
		if m.ID == userID {
			return true
		}
	}
	return false
}
