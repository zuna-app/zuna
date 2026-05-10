package data

type ChatMemberDTO struct {
	ID                  string `json:"id"`
	ChatID              string `json:"chat_id"`
	Username            string `json:"username"`
	Avatar              string `json:"avatar"`
	IdentityKey         string `json:"identity_key"`
	LastMessageSenderID string `json:"last_message_sender_id"`
	LastCipherText      string `json:"cipher_text"`
	LastIv              string `json:"iv"`
	LastAuthTag         string `json:"auth_tag"`
	UnreadMessages      int    `json:"unread_messages"`
	LastChatActivity    int64  `json:"last_chat_activity"`
}

type UserInfoDTO struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	Avatar      string `json:"avatar"`
	IdentityKey string `json:"identity_key"`
}

type MessageDTO struct {
	ID                        int64               `json:"id"`
	ClientMessageID           string              `json:"client_message_id"`
	SenderID                  string              `json:"sender_id"`
	CipherText                string              `json:"cipher_text"`
	Iv                        string              `json:"iv"`
	AuthTag                   string              `json:"auth_tag"`
	SentAt                    int64               `json:"sent_at"`
	ReadAt                    int64               `json:"read_at"`
	AttachmentID              string              `json:"attachment_id"`
	AttachmentMetadata        string              `json:"attachment_metadata"`
	AttachmentMetadataIv      string              `json:"attachment_metadata_iv"`
	AttachmentMetadataAuthTag string              `json:"attachment_metadata_auth_tag"`
	Modified                  bool                `json:"modified"`
	Pinned                    bool                `json:"pinned"`
	IsReply                   bool                `json:"is_reply"`
	ReplyInfo                 MessageReplyInfoDTO `json:"reply_info"`
}

type MessageReplyInfoDTO struct {
	ID            int64  `json:"id"`
	CipherText    string `json:"cipher_text"`
	Iv            string `json:"iv"`
	AuthTag       string `json:"auth_tag"`
	HasAttachment bool   `json:"has_attachment"`
}

type PresenceDTO struct {
	UserID   string `json:"user_id"`
	LastSeen int64  `json:"last_seen"`
	Active   bool   `json:"active"`
}

type ChannelDTO struct {
	ID             string                 `json:"id"`
	Name           string                 `json:"name"`
	IsPublic       bool                   `json:"is_public"`
	ChannelType    string                 `json:"channel_type"`
	OwnerID        string                 `json:"owner_id"`
	CreatedAt      int64                  `json:"created_at"`
	LastMessage    *ChannelLastMessageDTO `json:"last_message,omitempty"`
	UnreadMessages int                    `json:"unread_messages"`
}

type VoiceParticipantDTO struct {
	UserID   string `json:"user_id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

type ChannelLastMessageDTO struct {
	SenderID   string `json:"sender_id"`
	CipherText string `json:"cipher_text"`
	Iv         string `json:"iv"`
	AuthTag    string `json:"auth_tag"`
	SentAt     int64  `json:"sent_at"`
}

type ChannelMessageDTO struct {
	ID                        int64  `json:"id"`
	ClientMessageID           string `json:"client_message_id"`
	SenderID                  string `json:"sender_id"`
	SenderUsername            string `json:"sender_username"`
	SenderAvatar              string `json:"sender_avatar"`
	CipherText                string `json:"cipher_text"`
	Iv                        string `json:"iv"`
	AuthTag                   string `json:"auth_tag"`
	SentAt                    int64  `json:"sent_at"`
	AttachmentID              string `json:"attachment_id,omitempty"`
	AttachmentMetadata        string `json:"attachment_metadata,omitempty"`
	AttachmentMetadataIv      string `json:"attachment_metadata_iv,omitempty"`
	AttachmentMetadataAuthTag string `json:"attachment_metadata_auth_tag,omitempty"`
}

type ChannelMemberDTO struct {
	UserID      string `json:"user_id"`
	Username    string `json:"username"`
	Avatar      string `json:"avatar"`
	IdentityKey string `json:"identity_key"`
}

type GroupKeyDTO struct {
	ChannelID      string `json:"channel_id"`
	SenderUserID   string `json:"sender_user_id"`
	SenderIdentKey string `json:"sender_identity_key"`
	EncryptedKey   string `json:"encrypted_key"`
	Iv             string `json:"iv"`
	AuthTag        string `json:"auth_tag"`
}

type KeyRequestDTO struct {
	ChannelID            string `json:"channel_id"`
	RecipientUserID      string `json:"recipient_user_id"`
	RecipientIdentityKey string `json:"recipient_identity_key"`
}
