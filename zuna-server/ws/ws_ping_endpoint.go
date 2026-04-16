package ws

import "encoding/json"

type WsPingRequest struct {
	Timestamp int64 `json:"ts"`
}

type WsPingResponse struct {
	Timestamp int64 `json:"ts"`
}

// Receive over: ping
// Response to sender over: ping
func (r *MessageRouter) handlePing(c HubClient, msg IncomingMessage) {
	var req WsPingRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "invalid json")
		return
	}

	c.Send(OutgoingMessage{Type: "pong", Payload: WsPingResponse{
		Timestamp: req.Timestamp,
	}})
}
