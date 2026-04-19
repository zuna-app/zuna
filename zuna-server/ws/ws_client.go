// Package ws handles the low-level WebSocket lifecycle: upgrading HTTP
// connections, running per-client read/write pumps, and wiring each client
// into the Hub.
package ws

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/labstack/echo/v5"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"golang.org/x/time/rate"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer (bytes).
	maxMessageSize = 4096

	// Size of the per-client outbound send buffer.
	sendBufferSize = 256

	// Size of the per-client inbound dispatch queue.
	dispatchQueueSize = 64

	// Number of workers processing messages from a single client.
	dispatchWorkers = 8

	// Per-client sustained message rate (messages per second).
	wsRateLimit = 40

	// Per-client burst allowance (messages).
	wsRateBurst = 80
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Allow all origins for development; tighten in production.
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Client is a concrete implementation of hub.Client.
// It pairs a WebSocket connection with a buffered send channel and
// runs independent read/write pumps in separate goroutines.
type Client struct {
	id            string
	conn          *websocket.Conn
	send          chan []byte
	dispatchQueue chan []byte
	h             *Hub
	r             *MessageRouter
	rateLimiter   *rate.Limiter
}

// ID returns the unique identifier assigned at connection time.
func (c *Client) ID() string { return c.id }

// Send marshals v to JSON and queues it for delivery to this client.
// If v is already a []byte it is queued as-is (allows the hub to pass
// pre-marshalled broadcast bytes without double-encoding).
// Returns an error if marshalling fails or the send buffer is full.
func (c *Client) Send(v any) error {
	var payload []byte
	switch p := v.(type) {
	case []byte:
		payload = p
	default:
		var err error
		if payload, err = json.Marshal(v); err != nil {
			return fmt.Errorf("client %s: marshal error: %w", c.id, err)
		}
	}
	select {
	case c.send <- payload:
		return nil
	default:
		return fmt.Errorf("client %s: send buffer full", c.id)
	}
}

// HandleWebSocket is an Echo handler factory that upgrades HTTP GET /ws
// requests to WebSocket connections and starts the client pumps.
func HandleWebSocket(h *Hub, r *MessageRouter) echo.HandlerFunc {
	return func(c *echo.Context) error {
		conn, err := upgrader.Upgrade(c.Response(), c.Request(), nil)
		if err != nil {
			log.Printf("[ws] upgrade error: %v", err)
			return err
		}

		client := &Client{
			id:            uuid.NewString(),
			conn:          conn,
			send:          make(chan []byte, sendBufferSize),
			dispatchQueue: make(chan []byte, dispatchQueueSize),
			h:             h,
			r:             r,
			rateLimiter:   rate.NewLimiter(wsRateLimit, wsRateBurst),
		}

		// Register with the hub before starting pumps so we never miss a
		// broadcast that fires immediately after registration.
		h.Register <- client

		// Each pump runs in its own goroutine; writePump owns the connection
		// write side, readPump owns the read side – no locking needed.
		client.startDispatchWorkers()
		go client.writePump()
		go client.readPump()

		return nil
	}
}

func (c *Client) startDispatchWorkers() {
	for i := 0; i < dispatchWorkers; i++ {
		go func() {
			for raw := range c.dispatchQueue {
				c.r.Dispatch(c, raw)
			}
		}()
	}
}

// readPump reads messages from the WebSocket connection and dispatches them
// to the message router. It is the only goroutine that reads from conn.
func (c *Client) readPump() {
	defer func() {
		close(c.dispatchQueue)
		c.h.Unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	_ = c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err,
				websocket.CloseGoingAway,
				websocket.CloseAbnormalClosure,
				websocket.CloseNormalClosure,
				websocket.CloseNoStatusReceived,
			) {
				log.Printf("[ws] read error client=%s: %v", c.id, err)
			}
			break
		}

		if !c.rateLimiter.Allow() {
			log.Printf("[ws] rate limit exceeded client=%s", c.id)
			sendError(c, "rate_limited", "too many messages, slow down")
			return
		}

		select {
		case c.dispatchQueue <- raw:
		default:
			log.Printf("[ws] dispatch queue overflow client=%s", c.id)
			return
		}
	}
}

// writePump drains the client's send channel and writes messages to the
// WebSocket connection. It is the only goroutine that writes to conn.
func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case payload, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))

			if !ok {
				// Hub closed the channel → send close frame and exit.
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				log.Printf("[ws] next-writer error client=%s: %v", c.id, err)
				return
			}

			if _, err = w.Write(payload); err != nil {
				log.Printf("[ws] write error client=%s: %v", c.id, err)
				return
			}

			// Flush any additional queued messages in the same frame batch.
		drain:
			for {
				select {
				case extra := <-c.send:
					if _, err = w.Write([]byte("\n")); err != nil {
						break drain
					}
					if _, err = w.Write(extra); err != nil {
						break drain
					}
				default:
					break drain
				}
			}

			if err = w.Close(); err != nil {
				log.Printf("[ws] writer-close error client=%s: %v", c.id, err)
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				if err != websocket.ErrCloseSent {
					log.Printf("[ws] ping error client=%s: %v", c.id, err)
				}
				return
			}
		}
	}
}
