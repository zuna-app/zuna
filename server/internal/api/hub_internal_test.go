package api

import (
	"net/http"
	"net/http/httptest"
	"runtime"
	"testing"

	"zuna/server/internal/store"
)

// Z-60: a relay that's stopped answering doesn't get a goroutine for each message.
func TestASlowRelayDoesntPileUpWork(t *testing.T) {
	release := make(chan struct{})
	relay := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { <-release }))
	defer relay.Close()
	defer close(release)
	s := &Server{pushClient: relay.Client(), pushQueue: make(chan pushJob, 8)}
	target := store.PushRegistration{Relay: relay.URL, Key: make([]byte, 32)}
	before := runtime.NumGoroutine()
	for range 5000 {
		s.push(target, pushAlert, map[string]string{}, "")
	}
	if extra := runtime.NumGoroutine() - before; extra > 200 {
		t.Fatalf("%d more goroutines", extra)
	}
}

// Z-50: a slow reader is cut off long before its queue is full, if what's queued is large.
func TestASlowReaderCantHaveTheServerHoldGigabytes(t *testing.T) {
	closed := false
	c := &conn{send: make(chan []byte, sendBufferSize), close: func() { closed = true }}
	frame := make([]byte, 16<<20)
	for range 4 {
		c.deliver(frame)
	}
	if closed {
		t.Fatal("cut off while still within the limit")
	}
	c.deliver(frame)
	if !closed {
		t.Fatal("80 MiB queued, and still connected")
	}
}
