package data

import (
	"errors"
	"slices"
	"sync"
)

// UserID -> User
var UserMap = make(map[string]User)
var userMutex sync.RWMutex

type User struct {
	UserID      string
	ServerIDs   []string
	Connections []ConnectionInfo
}

type ConnectionInfo struct {
	ConnectionID string
	Mobile       bool
}

func (u *User) IsInServer(serverId string) bool {
	return slices.Contains(u.ServerIDs, serverId)
}

func (u *User) AddConnection(connectionId string, mobile bool) {
	u.Connections = append(u.Connections, ConnectionInfo{
		ConnectionID: connectionId,
		Mobile:       mobile,
	})
}

func (u *User) IsConnectedFromDesktop() bool {
	for _, conn := range u.Connections {
		if !conn.Mobile {
			return true
		}
	}
	return false
}

func (u *User) RemoveConnection(connectionId string) {
	userMutex.Lock()
	defer userMutex.Unlock()

	if ud, ok := UserMap[u.UserID]; ok {
		newConnections := make([]ConnectionInfo, 0, len(ud.Connections))
		for _, conn := range ud.Connections {
			if conn.ConnectionID != connectionId {
				newConnections = append(newConnections, conn)
			}
		}
		ud.Connections = newConnections
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
		for _, conn := range ud.Connections {
			if conn.ConnectionID == connectionId {
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
