package ws

import (
	"encoding/json"
	"zuna-server/data"
)

// Receive over: last_seen_request
// Response to sender over: last_seen_response

type WsLastSeenRequest struct {
	Token string `json:"token"`
}

type WsLastSeenResponse struct {
	LastSeen []data.LastSeenDTO `json:"last_seen"`
}

func (r *MessageRouter) handleLastSeenRequest(c HubClient, msg IncomingMessage) {
	var req WsLastSeenRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendError(c, "bad_request", "bad request")
		return
	}

	_, err := data.GetUserDataByToken(req.Token)
	if err != nil {
		sendError(c, "forbidden", "forbidden")
		return
	}

	ls := make([]data.LastSeenDTO, 0)
	for _, ud := range data.UserDataMap {
		ls = append(ls, data.LastSeenDTO{
			UserID:   ud.UserID,
			LastSeen: ud.LastSeen,
		})
	}

	c.Send(OutgoingMessage{Type: "last_seen_response", Payload: WsLastSeenResponse{
		LastSeen: ls,
	}})
}
