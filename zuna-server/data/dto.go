package data

type ChatMemberDTO struct {
	ID                  string `json:"id"`
	ChatID              string `json:"chat_id"`
	Username            string `json:"username"`
	Avatar              string `json:"avatar"`
	AvatarIv            string `json:"avatar_iv"`
	AvatarAuthTag       string `json:"avatar_auth_tag"`
	IdentityKey         string `json:"identity_key"`
	LastMessageSenderID string `json:"last_message_sender_id"`
	LastCipherText      string `json:"cipher_text"`
	LastIv              string `json:"iv"`
	LastAuthTag         string `json:"auth_tag"`
	UnreadMessages      int    `json:"unread_messages"`
	LastChatActivity    int64  `json:"last_chat_activity"`
}

type MessageDTO struct {
	ID         int64  `json:"id"`
	SenderID   string `json:"sender_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
	SentAt     int64  `json:"sent_at"`
	ReadAt     int64  `json:"read_at"`
}

type PresenceDTO struct {
	UserID   string `json:"user_id"`
	LastSeen int64  `json:"last_seen"`
	Active   bool   `json:"active"`
}
