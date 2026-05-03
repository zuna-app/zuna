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
	WebPushSubs []WebPushSubscription
}

type ConnectionInfo struct {
	ConnectionID string
	Mobile       bool
}

type WebPushSubscription struct {
	Endpoint string
	P256DH   string
	Auth     string
}

func (u *User) IsInServer(serverId string) bool {
	return slices.Contains(u.ServerIDs, serverId)
}

func (u *User) AddServerID(serverID string) {
	if serverID == "" {
		return
	}

	if !slices.Contains(u.ServerIDs, serverID) {
		u.ServerIDs = append(u.ServerIDs, serverID)
	}
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

func (u *User) AddOrUpdateWebPushSubscription(sub WebPushSubscription) {
	for i := range u.WebPushSubs {
		if u.WebPushSubs[i].Endpoint == sub.Endpoint {
			u.WebPushSubs[i] = sub
			return
		}
	}

	u.WebPushSubs = append(u.WebPushSubs, sub)
}

func (u *User) RemoveWebPushSubscription(endpoint string) bool {
	removed := false
	newSubs := make([]WebPushSubscription, 0, len(u.WebPushSubs))
	for _, sub := range u.WebPushSubs {
		if sub.Endpoint == endpoint {
			removed = true
			continue
		}

		newSubs = append(newSubs, sub)
	}

	u.WebPushSubs = newSubs
	return removed
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
