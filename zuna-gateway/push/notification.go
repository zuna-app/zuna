package push

type NotificationPayload struct {
	ServerID          string `json:"server_id"`
	SenderID          string `json:"sender_id"`
	SenderIdentityKey string `json:"sender_identity_key"`
	CipherText        string `json:"cipher_text"`
	Iv                string `json:"iv"`
	AuthTag           string `json:"auth_tag"`
	Signature         string `json:"signature"`
}

type ApnPayload struct {
	APS ApnAPS `json:"aps"`

	SenderID          string `json:"sid"`
	ServerID          string `json:"srv"`
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
}
