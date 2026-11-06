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
	off, _ := New(false, nil, false)
	if got := off.Address(request("127.0.0.1:1", "6.6.6.6")); got != "127.0.0.1" {
		t.Fatalf("trusting nobody: %s", got)
	}
	on, _ := New(true, nil, false)
	if got := on.Address(request("8.8.8.8:1", "6.6.6.6")); got != "8.8.8.8" {
		t.Fatalf("a direct connection from outside named someone else: %s", got)
	}
}

func TestOnlyWhatTheProxyAddedCounts(t *testing.T) {
	resolver, _ := New(true, nil, false)
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
	resolver, err := New(false, []string{"203.0.113.7", "198.51.100.0/24"}, false)
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
	if _, err := New(false, []string{"not-a-network"}, false); err == nil {
		t.Fatal("a bad network should be refused")
	}
}

// Anyone can call through Cloudflare from one of its addresses, with a Worker,
// and say what they like further left.
func TestCloudflaresAddressesAreNeverPassedThrough(t *testing.T) {
	listed, _ := New(false, []string{"127.0.0.1", "162.158.0.0/15", "2a06:98c0::/29"}, false)
	worker := request("127.0.0.1:1", "6.6.6.6, 2a06:98c0:3600::103, 162.158.1.1")
	if got := listed.Address(worker); got != "162.158.1.1" {
		t.Fatalf("listed Cloudflare addresses were passed through: %s", got)
	}
	behind, _ := New(false, []string{"127.0.0.1", "162.158.0.0/15", "2a06:98c0::/29"}, true)
	worker.Header.Set("CF-Connecting-IP", "2a06:98c0:3600::103")
	if got := behind.Address(worker); got != "2a06:98c0:3600::103" {
		t.Fatalf("a Worker behind Cloudflare: %s", got)
	}
}

func TestBehindCloudflareItNamesTheCaller(t *testing.T) {
	behind, _ := New(true, nil, true)
	// What nginx sends with $proxy_add_x_forwarded_for, and Caddy as the installer sets it up.
	through := request("127.0.0.1:1", "1.1.1.1, 9.9.9.9, 162.158.1.1")
	through.Header.Set("CF-Connecting-IP", "9.9.9.9")
	if got := behind.Address(through); got != "9.9.9.9" {
		t.Fatalf("through Cloudflare and a proxy: %s", got)
	}
	// Straight to the server, around Cloudflare: the header is whatever the caller said.
	around := request("127.0.0.1:1", "198.51.100.7")
	around.Header.Set("CF-Connecting-IP", "1.2.3.4")
	if got := behind.Address(around); got != "198.51.100.7" {
		t.Fatalf("around Cloudflare: %s", got)
	}
	// A proxy that already took the address from Cloudflare, as nginx's realip does.
	restored := request("127.0.0.1:1", "9.9.9.9")
	restored.Header.Set("CF-Connecting-IP", "9.9.9.9")
	if got := behind.Address(restored); got != "9.9.9.9" {
		t.Fatalf("restored by the proxy: %s", got)
	}
	// Cloudflare calling the server itself, with no proxy between.
	direct := request("162.158.1.1:1")
	direct.Header.Set("CF-Connecting-IP", "9.9.9.9")
	if got := behind.Address(direct); got != "9.9.9.9" {
		t.Fatalf("straight from Cloudflare: %s", got)
	}
	notBehind, _ := New(true, nil, false)
	if got := notBehind.Address(through); got != "162.158.1.1" {
		t.Fatalf("not behind Cloudflare, its header counted: %s", got)
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
