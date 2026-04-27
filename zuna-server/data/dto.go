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
	ID       string `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

type MessageDTO struct {
	ID                        int64               `json:"id"`
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
