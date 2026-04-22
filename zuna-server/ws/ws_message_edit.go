package ws

import (
	"context"
	"encoding/json"
	"zuna-server/config"
	"zuna-server/data"
	"zuna-server/db"
	"zuna-server/ent/message"

	"github.com/rs/zerolog/log"
)

type ModifyMessageRequest struct {
	Id         int64  `json:"id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

type ModifyMessageResponseMulticast struct {
	Id         int64  `json:"id"`
	ChatId     string `json:"chat_id"`
	SenderId   string `json:"sender_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
}

// Receive over: message_modify
// Response to chat members over: message_modify_receive
func (r *MessageRouter) handleModifyMessage(c HubClient, msg IncomingMessage, userData data.UserData) {
	var req ModifyMessageRequest
	if err := json.Unmarshal(msg.Payload, &req); err != nil {
		sendInvalidRequest(c)
		return
	}

	if int64(len(req.CipherText)) > config.Config.Limits.MaxMessageSize {
		sendError(c, "bad_request", "message too large")
		return
	}

	ctx := context.Background()
	m, err := db.EntClient.Message.Query().WithChat().WithUser().Where(message.IDEQ(req.Id)).First(ctx)
	if err != nil {
		log.Error().Err(err).Int64("messageId", req.Id).Msg("failed to query message")
		sendInternalServerError(c)
		return
	}

	if m.Edges.User.ID != userData.UserID {
		sendForbidden(c)
		return
	}

	ch := m.Edges.Chat

	_, err = m.Update().SetCipherText(req.CipherText).SetIv(req.Iv).SetAuthTag(req.AuthTag).SetModified(true).Save(ctx)
	if err != nil {
		log.Error().Err(err).Int64("messageId", req.Id).Msg("failed to update message")
		sendInternalServerError(c)
		return
	}

	for _, uu := range ch.Edges.Users {
		if uu.ID == userData.UserID {
			continue
		}

		ud, err := data.GetUserDataByUsername(uu.Username)
		if err != nil || ud.ConnectionID == "" {
			continue
		}
		r.h.SendTo(ud.ConnectionID, OutgoingMessage{Type: "message_modify_receive", Payload: ModifyMessageResponseMulticast{
			Id:         m.ID,
			ChatId:     ch.ID,
			SenderId:   userData.UserID,
			CipherText: req.CipherText,
			Iv:         req.Iv,
			AuthTag:    req.AuthTag,
		}})
	}
}
