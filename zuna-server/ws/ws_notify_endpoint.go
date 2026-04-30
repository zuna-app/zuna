package ws

import (
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v5"
)

const (
	notifyWriteWait      = 10 * time.Second
	notifyPongWait       = 60 * time.Second
	notifyPingPeriod     = (notifyPongWait * 9) / 10
	notifySendBufferSize = 64
)

// NotifyClient is a lightweight WebSocket peer used only for receiving
// notification_info push events. No token auth is required; the client
// identifies itself via a register_request message.
type NotifyClient struct {
	id     string
	userID string
	conn   *websocket.Conn
	send   chan []byte
	hub    *NotifyHub
}

type notifyRegisterRequest struct {
	UserID string `json:"user_id"`
}

// HandleNotifyWebSocket returns an Echo handler for the /ws/notify endpoint.
// Connections are unauthenticated; clients register by sending:
//
//	{"type":"register_request","payload":{"user_id":"<id>"}}
func HandleNotifyWebSocket(h *NotifyHub) echo.HandlerFunc {
	return func(c *echo.Context) error {
		conn, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
		if err != nil {
			log.Printf("[notify-ws] upgrade error: %v", err)
			return err
		}

		client := &NotifyClient{
			id:   uuid.NewString(),
			conn: conn,
			send: make(chan []byte, notifySendBufferSize),
			hub:  h,
		}

		go client.writePump()
		client.readPump()
		return nil
	}
}

// readPump processes incoming frames. Only register_request is handled;
// all other message types are silently ignored.
func (c *NotifyClient) readPump() {
	defer func() {
		if c.userID != "" {
			c.hub.unregisterNotifyClient(c.userID, c.id)
		}
		c.conn.Close()
	}()

	c.conn.SetReadLimit(512)
	_ = c.conn.SetReadDeadline(time.Now().Add(notifyPongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(notifyPongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg IncomingMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		if msg.Type == "register_request" {
			if c.userID != "" {
				// Already registered; ignore duplicate
				continue
			}
			var req notifyRegisterRequest
			if err := json.Unmarshal(msg.Payload, &req); err != nil || req.UserID == "" {
				continue
			}
			c.userID = req.UserID
			c.hub.registerNotifyClient(req.UserID, c)
		}
	}
}

// writePump delivers outbound frames and sends periodic pings.
func (c *NotifyClient) writePump() {
	ticker := time.NewTicker(notifyPingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(notifyWriteWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(notifyWriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
