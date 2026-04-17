package ws

import (
	"encoding/json"
	"zuna-server/data"
)

type PingRequest struct {
	Timestamp int64 `json:"ts"`
}

type PingResponse struct {
	Timestamp int64 `json:"ts"`
}

// Receive over: ping
// Response to sender over: ping
func (r *MessageRouter) handlePing(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req PingRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "invalid json")
		return
	}

	c.Send(OutgoingMessage{Type: "pong", Payload: PingResponse{
		Timestamp: req.Timestamp,
	}})
}
