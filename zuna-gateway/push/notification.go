package push

type NotificationPayload struct {
	UserID              string `json:"user_id"`
	ServerID            string `json:"server_id"`
	ChatID              string `json:"chat_id"`
	SenderID            string `json:"sender_id"`
	SenderIdentityKey   string `json:"sender_identity_key"`
	CipherText          string `json:"cipher_text"`
	Iv                  string `json:"iv"`
	AuthTag             string `json:"auth_tag"`
	Signature           string `json:"signature"`
	UnreadNotifications int    `json:"unread_notifications"`
}

type ApnPayload struct {
	APS ApnAPS `json:"aps"`

	UserID            string `json:"uid"`
	SenderID          string `json:"sid"`
	ServerID          string `json:"srv"`
	ChatID            string `json:"cid"`
	CipherText        string `json:"ct"`
	Iv                string `json:"iv"`
	AuthTag           string `json:"at"`
	SenderIdentityKey string `json:"sik"`
	Signature         string `json:"sig"`
}

type ApnAlert struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type ApnAPS struct {
	Alert             ApnAlert `json:"alert"`
	Sound             string   `json:"sound"`
	MutableContent    int      `json:"mutable-content"`
	ThreadID          string   `json:"thread-id"`
	InterruptionLevel string   `json:"interruption-level"`
	Badge             int      `json:"badge"`
}

type ApnPayloadBadge struct {
	APS ApnAPSBadge `json:"aps"`
}

type ApnAPSBadge struct {
	Badge int `json:"badge"`
}
