package data

import "sync"

var voiceChannelsMu sync.RWMutex
var voiceChannels = make(map[string]map[string]VoiceParticipantDTO)

func JoinVoiceChannel(channelId, userId, username, avatar string) {
	voiceChannelsMu.Lock()
	defer voiceChannelsMu.Unlock()
	if voiceChannels[channelId] == nil {
		voiceChannels[channelId] = make(map[string]VoiceParticipantDTO)
	}
	voiceChannels[channelId][userId] = VoiceParticipantDTO{
		UserID:   userId,
		Username: username,
		Avatar:   avatar,
	}
}

func LeaveVoiceChannel(channelId, userId string) {
	voiceChannelsMu.Lock()
	defer voiceChannelsMu.Unlock()
	if voiceChannels[channelId] != nil {
		delete(voiceChannels[channelId], userId)
	}
}

func GetVoiceChannelParticipants(channelId string) []VoiceParticipantDTO {
	voiceChannelsMu.RLock()
	defer voiceChannelsMu.RUnlock()
	participants := make([]VoiceParticipantDTO, 0)
	for _, p := range voiceChannels[channelId] {
		participants = append(participants, p)
	}
	return participants
}

// LeaveAllVoiceChannels removes a user from every voice channel they are in.
// Returns the channel IDs they were removed from so callers can broadcast updates.
func LeaveAllVoiceChannels(userId string) []string {
	voiceChannelsMu.Lock()
	defer voiceChannelsMu.Unlock()
	affected := make([]string, 0)
	for channelId, participants := range voiceChannels {
		if _, ok := participants[userId]; ok {
			delete(participants, userId)
			affected = append(affected, channelId)
		}
	}
	return affected
}
