package api

import "encoding/binary"

// The server can't read MLS content, but it can read the outside of an MLS
// message (RFC 9420, section 6). Bytes that aren't a commit or group info for
// this group and epoch would strand every member, so they're refused here.

const (
	mlsVersion10 = 1

	wirePublicMessage  = 1
	wirePrivateMessage = 2
	wireGroupInfo      = 4

	contentCommit = 3

	senderMember          = 1
	senderNewMemberCommit = 4
)

// A reader over the TLS presentation language that MLS uses.
type frameReader struct {
	data []byte
	ok   bool
}

func (r *frameReader) take(n uint64) []byte {
	if !r.ok || uint64(len(r.data)) < n {
		r.ok = false
		return nil
	}
	out := r.data[:n]
	r.data = r.data[n:]
	return out
}

func (r *frameReader) u8() uint8 {
	if b := r.take(1); b != nil {
		return b[0]
	}
	return 0
}

func (r *frameReader) u16() uint16 {
	if b := r.take(2); b != nil {
		return binary.BigEndian.Uint16(b)
	}
	return 0
}

func (r *frameReader) u64() uint64 {
	if b := r.take(8); b != nil {
		return binary.BigEndian.Uint64(b)
	}
	return 0
}

// vector reads a variable-length vector: a length of 1, 2 or 4 bytes (the top
// two bits of the first say which), then that many bytes.
func (r *frameReader) vector() []byte {
	first := r.u8()
	if !r.ok {
		return nil
	}
	size := uint64(first & 0x3f)
	switch first >> 6 {
	case 0:
	case 1:
		size = size<<8 | uint64(r.u8())
	case 2:
		rest := r.take(3)
		if rest == nil {
			return nil
		}
		size = size<<24 | uint64(rest[0])<<16 | uint64(rest[1])<<8 | uint64(rest[2])
	default:
		r.ok = false
		return nil
	}
	return r.take(size)
}

// wireFormat reads what every MLS message starts with: its version and format.
func (r *frameReader) wireFormat() uint16 {
	if version := r.u16(); version != mlsVersion10 {
		r.ok = false
	}
	return r.u16()
}

// validCommitFrame reports whether data is an MLS commit for this group, built
// on this epoch. Commits from members are encrypted and new members' are public.
func validCommitFrame(data []byte, groupID string, epoch int64) bool {
	r := &frameReader{data: data, ok: true}
	switch r.wireFormat() {
	case wirePrivateMessage:
		id := r.vector()
		at := r.u64()
		content := r.u8()
		r.vector() // authenticated data
		sender := r.vector()
		ciphertext := r.vector()
		return r.ok && len(r.data) == 0 && string(id) == groupID && at == uint64(epoch) && content == contentCommit &&
			len(sender) > 0 && len(ciphertext) > 0
	case wirePublicMessage:
		id := r.vector()
		at := r.u64()
		switch r.u8() {
		case senderMember:
			r.take(4)
		case senderNewMemberCommit:
		default:
			return false
		}
		r.vector() // authenticated data
		content := r.u8()
		return r.ok && string(id) == groupID && at == uint64(epoch) && content == contentCommit
	}
	return false
}

// validGroupInfoFrame reports whether data is an MLS group info for this group
// at this epoch. Only its signature proves it genuine, which clients check.
func validGroupInfoFrame(data []byte, groupID string, epoch int64) bool {
	r := &frameReader{data: data, ok: true}
	if r.wireFormat() != wireGroupInfo {
		return false
	}
	r.u16() // the version again, in the group's context
	r.u16() // the ciphersuite
	id := r.vector()
	at := r.u64()
	return r.ok && string(id) == groupID && at == uint64(epoch)
}
