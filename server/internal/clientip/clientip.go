// Package clientip works out who is really calling, for rate limits. Only a
// connection from a trusted proxy may name someone else in X-Forwarded-For, and
// only what that proxy itself added counts: proxies append the address they saw,
// so anything further left is whatever the caller made up.
package clientip

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// Resolver reads callers' addresses from requests. Its zero value trusts nobody.
type Resolver struct {
	trusted []netip.Prefix
}

// The networks a reverse proxy on this machine or a private network connects from.
var privateNetworks = []netip.Prefix{
	netip.MustParsePrefix("127.0.0.0/8"),
	netip.MustParsePrefix("10.0.0.0/8"),
	netip.MustParsePrefix("172.16.0.0/12"),
	netip.MustParsePrefix("192.168.0.0/16"),
	netip.MustParsePrefix("169.254.0.0/16"),
	netip.MustParsePrefix("::1/128"),
	netip.MustParsePrefix("fc00::/7"),
	netip.MustParsePrefix("fe80::/10"),
}

// New makes a resolver. A list of networks (addresses or CIDR ranges) is exactly
// who to trust. Without one, trustProxy trusts this machine and private networks,
// where a reverse proxy usually is, and never a direct connection from outside.
func New(trustProxy bool, networks []string) (*Resolver, error) {
	if len(networks) == 0 {
		if trustProxy {
			return &Resolver{trusted: privateNetworks}, nil
		}
		return &Resolver{}, nil
	}
	trusted := make([]netip.Prefix, 0, len(networks))
	for _, network := range networks {
		prefix, err := parseNetwork(network)
		if err != nil {
			return nil, fmt.Errorf("the trusted proxy %q isn't an address or CIDR range", network)
		}
		trusted = append(trusted, prefix)
	}
	return &Resolver{trusted: trusted}, nil
}

func parseNetwork(network string) (netip.Prefix, error) {
	if strings.Contains(network, "/") {
		prefix, err := netip.ParsePrefix(network)
		return prefix.Masked(), err
	}
	addr, err := netip.ParseAddr(network)
	if err != nil {
		return netip.Prefix{}, err
	}
	addr = addr.Unmap()
	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

func (r *Resolver) isTrusted(addr netip.Addr) bool {
	for _, prefix := range r.trusted {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// Address is the caller's address: the nearest one in the chain of proxies that
// isn't itself a trusted proxy.
func (r *Resolver) Address(req *http.Request) string {
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	peer = peer.Unmap()
	if !r.isTrusted(peer) {
		return peer.String()
	}
	hops := strings.Split(strings.Join(req.Header.Values("X-Forwarded-For"), ","), ",")
	nearest := peer
	for i := len(hops) - 1; i >= 0; i-- {
		hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}
		hop = hop.Unmap()
		nearest = hop
		if !r.isTrusted(hop) {
			break
		}
	}
	return nearest.String()
}

// Key is what a rate limit should count an address under. One IPv6 network is
// usually one customer, with more addresses than anyone could use up, so all of
// a /64 count as one.
func Key(address string) string {
	return KeyWithin(address, 64)
}

// KeyWithin counts all of an IPv6 network of this many bits as one address, for a
// limit where someone with many /64s, as a free tunnel's /48 gives, mustn't get
// more tries for each.
func KeyWithin(address string, bits int) string {
	addr, err := netip.ParseAddr(address)
	if err != nil {
		return address
	}
	addr = addr.Unmap()
	if addr.Is6() {
		prefix, err := addr.Prefix(bits)
		if err == nil {
			return prefix.String()
		}
	}
	return addr.String()
}
