// Package clientip works out who is really calling, for rate limits. Only a
// connection from a trusted proxy may name someone else in X-Forwarded-For, and
// only what that proxy itself added counts: proxies append the address they saw,
// so anything further left is whatever the caller made up.
//
// Cloudflare's addresses are never trusted that way, even when listed: anyone can
// call from one through a Worker and make up the rest. Behind Cloudflare's proxy,
// a request from one of them is from whoever it names in CF-Connecting-IP.
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
	trusted    []netip.Prefix
	cloudflare bool
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

// Cloudflare's addresses, from cloudflare.com/ips, which its proxy and its
// Workers call from.
var cloudflareNetworks = []netip.Prefix{
	netip.MustParsePrefix("173.245.48.0/20"),
	netip.MustParsePrefix("103.21.244.0/22"),
	netip.MustParsePrefix("103.22.200.0/22"),
	netip.MustParsePrefix("103.31.4.0/22"),
	netip.MustParsePrefix("141.101.64.0/18"),
	netip.MustParsePrefix("108.162.192.0/18"),
	netip.MustParsePrefix("190.93.240.0/20"),
	netip.MustParsePrefix("188.114.96.0/20"),
	netip.MustParsePrefix("197.234.240.0/22"),
	netip.MustParsePrefix("198.41.128.0/17"),
	netip.MustParsePrefix("162.158.0.0/15"),
	netip.MustParsePrefix("104.16.0.0/13"),
	netip.MustParsePrefix("104.24.0.0/14"),
	netip.MustParsePrefix("172.64.0.0/13"),
	netip.MustParsePrefix("131.0.72.0/22"),
	netip.MustParsePrefix("2400:cb00::/32"),
	netip.MustParsePrefix("2606:4700::/32"),
	netip.MustParsePrefix("2803:f800::/32"),
	netip.MustParsePrefix("2405:b500::/32"),
	netip.MustParsePrefix("2405:8100::/32"),
	netip.MustParsePrefix("2a06:98c0::/29"),
	netip.MustParsePrefix("2c0f:f248::/32"),
}

// New makes a resolver. A list of networks (addresses or CIDR ranges) is exactly
// who to trust. Without one, trustProxy trusts this machine and private networks,
// where a reverse proxy usually is, and never a direct connection from outside.
// behindCloudflare takes a request that comes from Cloudflare to be from whoever
// it names in CF-Connecting-IP.
func New(trustProxy bool, networks []string, behindCloudflare bool) (*Resolver, error) {
	if len(networks) == 0 {
		if trustProxy {
			return &Resolver{trusted: privateNetworks, cloudflare: behindCloudflare}, nil
		}
		return &Resolver{cloudflare: behindCloudflare}, nil
	}
	trusted := make([]netip.Prefix, 0, len(networks))
	for _, network := range networks {
		prefix, err := parseNetwork(network)
		if err != nil {
			return nil, fmt.Errorf("the trusted proxy %q isn't an address or CIDR range", network)
		}
		trusted = append(trusted, prefix)
	}
	return &Resolver{trusted: trusted, cloudflare: behindCloudflare}, nil
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

func contains(networks []netip.Prefix, addr netip.Addr) bool {
	for _, prefix := range networks {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// isTrusted reports whether an address is a proxy to believe about who's behind
// it. Cloudflare's never are.
func (r *Resolver) isTrusted(addr netip.Addr) bool {
	return contains(r.trusted, addr) && !contains(cloudflareNetworks, addr)
}

// Address is the caller's address: the nearest one in the chain of proxies that
// isn't itself a trusted proxy, or, behind Cloudflare, whoever Cloudflare names
// when that's one of its addresses.
func (r *Resolver) Address(req *http.Request) string {
	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		host = req.RemoteAddr
	}
	peer, err := netip.ParseAddr(host)
	if err != nil {
		return host
	}
	nearest := peer.Unmap()
	if r.isTrusted(nearest) {
		hops := strings.Split(strings.Join(req.Header.Values("X-Forwarded-For"), ","), ",")
		for i := len(hops) - 1; i >= 0; i-- {
			hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
			if err != nil {
				break
			}
			nearest = hop.Unmap()
			if !r.isTrusted(nearest) {
				break
			}
		}
	}
	// Cloudflare sets this itself on what it passes on. Only a request it passed on
	// counts: anyone else could have made it up.
	if r.cloudflare && contains(cloudflareNetworks, nearest) {
		if client, err := netip.ParseAddr(strings.TrimSpace(req.Header.Get("CF-Connecting-IP"))); err == nil {
			return client.Unmap().String()
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
