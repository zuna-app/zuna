package lk

import (
	"context"
	"time"

	"github.com/livekit/protocol/livekit"
)

// Remove not used rooms every 5 minutes if client does not send call_end message
func CleanupRooms() {
	for {
		time.Sleep(5 * time.Minute)

		rc := newRoomClient()
		ctx := context.Background()

		rooms, err := rc.ListRooms(ctx, &livekit.ListRoomsRequest{})
		if err != nil {
			return
		}

		for _, room := range rooms.Rooms {
			if room.GetNumParticipants() == 0 {
				rc.DeleteRoom(ctx, &livekit.DeleteRoomRequest{Room: room.Name})
			}
		}
	}
}
