package api

import (
	"encoding/binary"
	"testing"
)

// The frames a commit can come in, and what of them isn't one.
func TestCommitFrames(t *testing.T) {
	vector := func(data []byte) []byte { return append([]byte{byte(len(data))}, data...) }
	header := func(wire uint16) []byte { return binary.BigEndian.AppendUint16([]byte{0, 1}, wire) }
	public := func(groupID string, epoch int64, sender []byte, content byte) []byte {
		frame := append(header(wirePublicMessage), vector([]byte(groupID))...)
		frame = binary.BigEndian.AppendUint64(frame, uint64(epoch))
		frame = append(frame, sender...)
		frame = append(frame, vector(nil)...)
		return append(frame, content, 'r', 'e', 's', 't')
	}
	for _, c := range []struct {
		name  string
		frame []byte
		want  bool
	}{
		{"a member's public commit", public("g", 3, []byte{senderMember, 0, 0, 0, 1}, contentCommit), true},
		{"a new member's commit", public("g", 3, []byte{senderNewMemberCommit}, contentCommit), true},
		{"from someone outside", public("g", 3, []byte{2}, contentCommit), false},
		{"for another group", public("h", 3, []byte{senderNewMemberCommit}, contentCommit), false},
		{"of another epoch", public("g", 4, []byte{senderNewMemberCommit}, contentCommit), false},
		{"not a commit", public("g", 3, []byte{senderNewMemberCommit}, 1), false},
		{"a welcome", append(header(wireWelcome), 0, 0), false},
		{"another version", append([]byte{0, 2}, header(wirePublicMessage)[2:]...), false},
		{"cut short", header(wirePublicMessage)[:3], false},
		{"nothing", nil, false},
	} {
		if got := validCommitFrame(c.frame, "g", 3); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}

// MLS's lengths take one, two or four bytes, by their first two bits.
func TestFrameVectors(t *testing.T) {
	long := make([]byte, 300)
	for _, c := range []struct {
		name string
		data []byte
		want int
		ok   bool
	}{
		{"one byte", append([]byte{3}, "abc"...), 3, true},
		{"two bytes", append([]byte{0x41, 0x2c}, long...), 300, true},
		{"four bytes", append([]byte{0x80, 0, 1, 0x2c}, long...), 300, true},
		{"four bytes cut short", []byte{0x80, 0}, 0, false},
		{"the length that isn't one", []byte{0xc0, 1}, 0, false},
		{"nothing", nil, 0, false},
		{"longer than what's there", []byte{5, 'a'}, 0, false},
	} {
		r := &frameReader{data: c.data, ok: true}
		got := r.vector()
		if r.ok != c.ok || len(got) != c.want {
			t.Errorf("%s: got %d bytes, ok %v", c.name, len(got), r.ok)
		}
	}
	r := &frameReader{data: []byte{1}, ok: true}
	if r.u64() != 0 || r.ok {
		t.Error("a u64 from one byte")
	}
	r = &frameReader{ok: true}
	if r.u8() != 0 || r.ok {
		t.Error("a u8 from nothing")
	}
}
