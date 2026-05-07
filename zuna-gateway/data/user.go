package data

import (
	"errors"
	"sync"
)

// UserID -> User
var UserMap = make(map[string]User)
var userMutex sync.RWMutex

type User struct {
	UserID        string
	ConnectionIDs []string
}

func (u *User) AddConnection(connectionId string, mobile bool) {
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
