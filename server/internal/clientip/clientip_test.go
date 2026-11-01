package clientip

import (
	"net/http"
	"testing"
)

func request(remote string, forwarded ...string) *http.Request {
	req := &http.Request{RemoteAddr: remote, Header: http.Header{}}
	for _, value := range forwarded {
		req.Header.Add("X-Forwarded-For", value)
	}
	return req
}

func TestAWordFromAnUntrustedCallerIsIgnored(t *testing.T) {
	off, _ := New(false, nil)
	if got := off.Address(request("127.0.0.1:1", "6.6.6.6")); got != "127.0.0.1" {
		t.Fatalf("trusting nobody: %s", got)
	}
	on, _ := New(true, nil)
	if got := on.Address(request("8.8.8.8:1", "6.6.6.6")); got != "8.8.8.8" {
		t.Fatalf("a direct connection from outside named someone else: %s", got)
	}
}

func TestOnlyWhatTheProxyAddedCounts(t *testing.T) {
	resolver, _ := New(true, nil)
	// What nginx sends: whatever the caller claimed, then the address it really saw.
	if got := resolver.Address(request("127.0.0.1:1", "1.1.1.1, 2.2.2.2, 9.9.9.9")); got != "9.9.9.9" {
		t.Fatalf("spoofed entries won: %s", got)
	}
	if got := resolver.Address(request("127.0.0.1:1", "1.1.1.1", "9.9.9.9")); got != "9.9.9.9" {
		t.Fatalf("across header lines: %s", got)
	}
	// Two proxies in a row, both trusted.
	if got := resolver.Address(request("127.0.0.1:1", "1.1.1.1, 9.9.9.9, 10.0.0.2")); got != "9.9.9.9" {
		t.Fatalf("through a second proxy: %s", got)
	}
	if got := resolver.Address(request("127.0.0.1:1")); got != "127.0.0.1" {
		t.Fatalf("no header: %s", got)
	}
	if got := resolver.Address(request("127.0.0.1:1", "junk")); got != "127.0.0.1" {
		t.Fatalf("a header that isn't an address: %s", got)
	}
}

func TestAListSaysExactlyWhoToTrust(t *testing.T) {
	resolver, err := New(false, []string{"203.0.113.7", "198.51.100.0/24"})
	if err != nil {
		t.Fatal(err)
	}
	if got := resolver.Address(request("203.0.113.7:1", "9.9.9.9")); got != "9.9.9.9" {
		t.Fatalf("a listed proxy: %s", got)
	}
	if got := resolver.Address(request("198.51.100.20:1", "9.9.9.9")); got != "9.9.9.9" {
		t.Fatalf("a listed range: %s", got)
	}
	if got := resolver.Address(request("127.0.0.1:1", "9.9.9.9")); got != "127.0.0.1" {
		t.Fatalf("a private address that isn't on the list: %s", got)
	}
	if _, err := New(false, []string{"not-a-network"}); err == nil {
		t.Fatal("a bad network should be refused")
	}
}

func TestOneIPv6NetworkCountsAsOne(t *testing.T) {
	if Key("2001:db8:1:2:aaaa::1") != Key("2001:db8:1:2:bbbb::2") {
		t.Fatal("addresses in one /64 should share a key")
	}
	if Key("2001:db8:1:2::1") == Key("2001:db8:1:3::1") {
		t.Fatal("different networks should not share a key")
	}
	if Key("192.0.2.1") == Key("192.0.2.2") {
		t.Fatal("IPv4 addresses are counted one by one")
	}
	if Key("::ffff:192.0.2.1") != Key("192.0.2.1") {
		t.Fatal("an IPv4 address written as IPv6 is the same address")
	}
}

func TestAWiderIPv6NetworkCountsAsOneWhenAsked(t *testing.T) {
	if KeyWithin("2001:db8:1:2::1", 48) != KeyWithin("2001:db8:1:ffff::1", 48) {
		t.Fatal("two /64s of one /48 counted apart")
	}
	if KeyWithin("2001:db8:1::1", 48) == KeyWithin("2001:db8:2::1", 48) {
		t.Fatal("two /48s counted as one")
	}
	if KeyWithin("192.0.2.1", 48) == KeyWithin("192.0.2.2", 48) {
		t.Fatal("IPv4 addresses counted as one")
	}
}
