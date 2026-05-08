package data

import (
	"errors"
	"sync"
)

// UserID -> User
var UserMap = make(map[string]User)
var userMutex sync.RWMutex
var tokenUsersMap = make(map[string]map[string]struct{})
var tokenUsersMutex sync.RWMutex

type User struct {
	UserID              string
	ConnectionIDs       []string
	UnreadNotifications int
}

func (u *User) AddConnection(connectionId string, mobile bool) {
	for _, conn := range u.ConnectionIDs {
		if conn == connectionId {
			return
		}
	}

	u.ConnectionIDs = append(u.ConnectionIDs, connectionId)
}

func (u *User) RemoveConnection(connectionId string) {
	userMutex.Lock()
	defer userMutex.Unlock()

	if ud, ok := UserMap[u.UserID]; ok {
		newConnections := make([]string, 0, len(ud.ConnectionIDs))
		for _, conn := range ud.ConnectionIDs {
			if conn != connectionId {
				newConnections = append(newConnections, conn)
			}
		}
		ud.ConnectionIDs = newConnections
		UserMap[u.UserID] = ud
	}
}

func GetUserByUserId(userId string) (User, error) {
	userMutex.RLock()
	defer userMutex.RUnlock()

	if ud, ok := UserMap[userId]; ok {
		return ud, nil
	}

	return User{}, errors.New("user not found")
}

func GetUserByConnectionId(connectionId string) (User, error) {
	userMutex.RLock()
	defer userMutex.RUnlock()

	for _, ud := range UserMap {
		for _, conn := range ud.ConnectionIDs {
			if conn == connectionId {
				return ud, nil
			}
		}
	}

	return User{}, errors.New("user is not connected")
}

func GetUsersByConnectionId(connectionId string) []User {
	userMutex.RLock()
	defer userMutex.RUnlock()

	users := make([]User, 0)
	for _, ud := range UserMap {
		for _, conn := range ud.ConnectionIDs {
			if conn == connectionId {
				users = append(users, ud)
				break
			}
		}
	}

	return users
}

func RemoveConnectionFromAll(connectionId string) {
	userMutex.Lock()
	defer userMutex.Unlock()

	for userId, ud := range UserMap {
		newConnections := make([]string, 0, len(ud.ConnectionIDs))
		for _, conn := range ud.ConnectionIDs {
			if conn != connectionId {
				newConnections = append(newConnections, conn)
			}
		}
		ud.ConnectionIDs = newConnections
		UserMap[userId] = ud
	}
}

func UpdateUser(user User) {
	userMutex.Lock()
	defer userMutex.Unlock()

	UserMap[user.UserID] = user
}

func DeleteUser(userId string) {
	userMutex.Lock()
	defer userMutex.Unlock()

	delete(UserMap, userId)
}

func GetUsersSnapshot() []User {
	userMutex.RLock()
	defer userMutex.RUnlock()

	users := make([]User, 0, len(UserMap))
	for _, ud := range UserMap {
		users = append(users, ud)
	}

	return users
}

func TrackDeviceTokens(userId string, tokens []string) {
	tokenUsersMutex.Lock()
	defer tokenUsersMutex.Unlock()

	for _, token := range tokens {
		if token == "" {
			continue
		}

		if _, ok := tokenUsersMap[token]; !ok {
			tokenUsersMap[token] = make(map[string]struct{})
		}
		tokenUsersMap[token][userId] = struct{}{}
	}
}

func DeleteTrackedDeviceToken(token string) {
	tokenUsersMutex.Lock()
	defer tokenUsersMutex.Unlock()

	delete(tokenUsersMap, token)
}

func GetTokenBadgeTotal(token string) int {
	tokenUsersMutex.RLock()
	usersMap, ok := tokenUsersMap[token]
	tokenUsersMutex.RUnlock()
	if !ok {
		return 0
	}

	userMutex.RLock()
	defer userMutex.RUnlock()

	total := 0
	for userId := range usersMap {
		if ud, exists := UserMap[userId]; exists {
			total += ud.UnreadNotifications
		}
	}

	return total
}
