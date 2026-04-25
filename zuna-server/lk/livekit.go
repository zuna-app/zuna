package lk

import (
	"context"
	"strings"
	"time"

	"zuna.chat/zuna-server/config"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/nrednav/cuid2"
)

func CreateRoom(CallerID string, RecipientID string) (string, string, string, error) {
	room := cuid2.Generate()
	canPublish := true
	canSubscribe := true

	atCaller := auth.NewAccessToken(config.Config.LiveKit.ApiKey, config.Config.LiveKit.ApiSecret)
	atCaller.SetVideoGrant(&auth.VideoGrant{
		RoomJoin:     true,
		Room:         room,
		CanPublish:   &canPublish,
		CanSubscribe: &canSubscribe,
	}).SetIdentity(CallerID).SetValidFor(3 * time.Minute)

	tokenCaller, err := atCaller.ToJWT()
	if err != nil {
		return "", "", "", err
	}

	atRecipient := auth.NewAccessToken(config.Config.LiveKit.ApiKey, config.Config.LiveKit.ApiSecret)
	if err != nil {
		return "", "", "", err
	}
	atRecipient.SetVideoGrant(&auth.VideoGrant{
		RoomJoin:     true,
		Room:         room,
		CanPublish:   &canPublish,
		CanSubscribe: &canSubscribe,
	}).SetIdentity(RecipientID).SetValidFor(3 * time.Minute)

	tokenRecipient, err := atRecipient.ToJWT()
	if err != nil {
		return "", "", "", err
	}

	return room, tokenCaller, tokenRecipient, nil
}

func DeleteRoom(roomName string) error {
	rc := newRoomClient()
	ctx := context.Background()
	_, err := rc.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: roomName})
	return err
}

func newRoomClient() *lksdk.RoomServiceClient {
	return lksdk.NewRoomServiceClient(toHTTPURL(config.Config.LiveKit.Url), config.Config.LiveKit.ApiKey, config.Config.LiveKit.ApiSecret)
}

func toHTTPURL(u string) string {
	if strings.HasPrefix(u, "ws://") {
		return "http://" + u[len("ws://"):]
	}
	if strings.HasPrefix(u, "wss://") {
		return "https://" + u[len("wss://"):]
	}
	return u
}
