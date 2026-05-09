package data

var Servers = make(map[string]ServerInfo)

type ServerInfo struct {
	IP              string
	InvalidRequests int64
	Banned          bool
}

func IsIPBanned(ip string) bool {
	info, exists := Servers[ip]
	return exists && info.Banned
}

func IncrementInvalidRequest(ip string) {
	info, exists := Servers[ip]
	if !exists {
		info = ServerInfo{IP: ip}
	}
	info.InvalidRequests++
	if info.InvalidRequests >= 10 {
		info.Banned = true
	}
	Servers[ip] = info
}