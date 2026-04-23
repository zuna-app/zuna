package ws

import (
	"encoding/json"
	"zuna-server/config"
	"zuna-server/data"
	"zuna-server/lk"
)

type CallStartRequest struct {
	RecipientID string `json:"recipient_id"`
}

type CallStartResponse struct {
	Room         string `json:"room"`
	LiveKitUrl   string `json:"livekit_url"`
	LiveKitToken string `json:"livekit_token"`
}

type CallStartRecipientResponse struct {
	CallerID     string `json:"caller_id"`
	RecipientID  string `json:"recipient_id"`
	Room         string `json:"room"`
	LiveKitUrl   string `json:"livekit_url"`
	LiveKitToken string `json:"livekit_token"`
}

// Receive over: call_start
// Response to sender over: call_start_confirmation
// Response to recipient over: call_start_info
func (r *MessageRouter) handleCallStart(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req CallStartRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	receipentData, err := data.GetUserDataByID(req.RecipientID)
	if err != nil {
		sendError(c, "bad_request", "recipient not found")
		return
	}

	if receipentData.ConnectionID == "" {
		sendError(c, "bad_request", "receipent is offline")
		return
	}

	room, tokenCaller, tokenRecipient, err := lk.CreateRoom(userData.UserID, req.RecipientID)
	if err != nil {
		sendInternalServerError(c)
		return
	}

	c.Send(OutgoingMessage{Type: "call_start_confirmation", Payload: CallStartResponse{
		Room:         room,
		LiveKitUrl:   config.Config.LiveKit.Url,
		LiveKitToken: tokenCaller,
	}})

	r.h.SendTo(receipentData.ConnectionID, OutgoingMessage{Type: "call_start_info", Payload: CallStartRecipientResponse{
		CallerID:     userData.UserID,
		RecipientID:  req.RecipientID,
		Room:         room,
		LiveKitUrl:   config.Config.LiveKit.Url,
		LiveKitToken: tokenRecipient,
	}})
}
