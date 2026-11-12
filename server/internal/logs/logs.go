// Package logs keeps what the server programs write from saying who called them.
package logs

import (
	"log"
	"log/slog"
	"net/netip"
	"strings"
)

// HTTPErrors is the ErrorLog for every http.Server, which net/http otherwise writes to
// with callers' addresses in, as in "TLS handshake error from 203.0.113.7:51234".
func HTTPErrors() *log.Logger {
	return log.New(errorWriter{}, "", 0)
}

type errorWriter struct{}

func (errorWriter) Write(line []byte) (int, error) {
	slog.Warn(Scrub(strings.TrimRight(string(line), "\n")))
	return len(line), nil
}

// Scrub takes out of text every IP address, with its port, and every run of 32 or more
// hex digits, which is what the IDs of accounts, devices and conversations look like.
// Addresses are found by asking netip about each run of the characters they're made
// of, as a pattern would take clock times and version numbers for them.
func Scrub(text string) string {
	var out strings.Builder
	for i := 0; i < len(text); {
		if !inAddress(text[i]) {
			out.WriteByte(text[i])
			i++
			continue
		}
		end := i
		for end < len(text) && inAddress(text[end]) {
			end++
		}
		out.WriteString(scrubRun(text[i:end]))
		i = end
	}
	return out.String()
}

func inAddress(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F' || c == '.' || c == ':'
}

// scrubRun takes a run of hex digits, dots and colons, which a sentence's punctuation
// may begin or end, as in "from 203.0.113.7:51234: EOF". The whole run is tried first,
// as "::1" and "2001:db8::" begin or end with what they're made of.
func scrubRun(run string) string {
	starts := []int{0, len(run) - len(strings.TrimLeft(run, ".:"))}
	ends := []int{len(run), len(strings.TrimRight(run, ".:"))}
	for _, start := range starts {
		for _, end := range ends {
			if start < end && isAddress(run[start:end]) {
				return run[:start] + "<address>" + run[end:]
			}
		}
	}
	return longHex(run)
}

func isAddress(text string) bool {
	if _, err := netip.ParseAddr(text); err == nil {
		return true
	}
	_, err := netip.ParseAddrPort(text)
	return err == nil
}

// longHex replaces each part of a run, between its dots and colons, that has 32 or more
// hex digits.
func longHex(run string) string {
	var out strings.Builder
	for i := 0; i < len(run); {
		if run[i] == '.' || run[i] == ':' {
			out.WriteByte(run[i])
			i++
			continue
		}
		end := i
		for end < len(run) && run[end] != '.' && run[end] != ':' {
			end++
		}
		if end-i >= 32 {
			out.WriteString("<id>")
		} else {
			out.WriteString(run[i:end])
		}
		i = end
	}
	return out.String()
}
