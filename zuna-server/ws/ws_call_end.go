package ws

import (
	"encoding/json"
	"zuna-server/data"
	"zuna-server/lk"
)

type CallEndRequest struct {
	Room        string `json:"room"`
	RecipientID string `json:"recipient_id"`
}

type CallEndRecipientResponse struct {
	Room string `json:"room"`
}

// Receive over: call_end
// Response to recipient over: call_end_info
func (r *MessageRouter) handleCallEnd(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req CallEndRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	receipentData, err := data.GetUserDataByID(req.RecipientID)
	if err != nil {
		sendError(c, "bad_request", "recipient not found")
		return
	}

	err = lk.DeleteRoom(req.Room)
	if err != nil {
		sendInternalServerError(c)
		return
	}

	if receipentData.ConnectionID != "" {
		r.h.SendTo(receipentData.ConnectionID, OutgoingMessage{Type: "call_end_info", Payload: CallEndRecipientResponse{
			Room: req.Room,
		}})
	}
}
