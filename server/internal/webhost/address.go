package webhost

import (
	"net/netip"
	"net/url"
	"strings"
)

// Ranges a public page can't be on, beyond what netip already knows about.
var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"), // benchmarking
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("64:ff9b::/96"), // NAT64, which can lead anywhere in IPv4
	netip.MustParsePrefix("2001:db8::/32"),
}

// privateAddress reports whether an address is on this machine or a network a
// public page shouldn't reach, as packages/core/src/links.ts decides on the desktop.
func privateAddress(addr netip.Addr) bool {
	addr = addr.Unmap()
	if !addr.IsValid() || addr.IsUnspecified() || addr.IsLoopback() || addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() || addr.IsLinkLocalMulticast() || addr.IsInterfaceLocalMulticast() || addr.IsMulticast() {
		return true
	}
	if addr.Is4() && addr.As4()[0] >= 224 {
		return true
	}
	for _, prefix := range reserved {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

// localName reports whether a name only means something on this machine or its network.
func localName(host string) bool {
	name := strings.ToLower(strings.TrimSuffix(host, "."))
	if !strings.Contains(name, ".") {
		return true
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".corp", ".home.arpa"} {
		if strings.HasSuffix(name, suffix) {
			return true
		}
	}
	return false
}

// devHost is a name that means this machine, which development builds may preview.
func devHost(host string) bool {
	name := strings.ToLower(host)
	return name == "localhost" || name == "127.0.0.1" || name == "::1" || strings.HasSuffix(name, ".localhost")
}

// previewable reports whether a link may be fetched for a preview: HTTPS to
// somewhere public, on the usual port. Pages can redirect anywhere, so this is
// checked again for every address along the way, and the address a name leads
// to is checked when connecting.
func (h *host) previewable(link *url.URL) bool {
	if link.User != nil {
		return false
	}
	name := link.Hostname()
	if h.cfg.AllowLocal && devHost(name) {
		return link.Scheme == "https" || link.Scheme == "http"
	}
	if link.Scheme != "https" || name == "" {
		return false
	}
	// A server can't be used to look for open ports elsewhere.
	if port := link.Port(); port != "" && port != "443" {
		return false
	}
	if addr, err := netip.ParseAddr(name); err == nil {
		return !privateAddress(addr)
	}
	return !localName(name)
}
