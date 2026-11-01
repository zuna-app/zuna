package api

import "testing"

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
