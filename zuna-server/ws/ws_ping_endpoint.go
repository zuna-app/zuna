package ws

import (
	"encoding/json"
	"time"
	"zuna-server/data"
)

type PingRequest struct {
	Timestamp int64  `json:"ts"`
	Token     string `json:"token"`
}

type PingResponse struct {
	Timestamp int64 `json:"ts"`
}

// Receive over: ping
// Response to sender over: ping
func (r *MessageRouter) handlePing(c HubClient, msg IncomingMessage) {
	var req PingRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "invalid json")
		return
	}

	ud, err := data.GetUserDataByToken(req.Token)
	if err != nil {
		sendError(c, "bad_request", "forbidden")
		return
	}

	ud.LastSeen = time.Now().UnixMilli()
	data.UserDataMap[ud.Username] = ud

	c.Send(OutgoingMessage{Type: "pong", Payload: PingResponse{
		Timestamp: req.Timestamp,
	}})
}
