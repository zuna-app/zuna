package webhost

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"zuna/server/internal/clientip"
)

// Link previews for the web app. A page can't read other sites, so the core in
// the browser asks its host to fetch them, as the desktop asks its main process
// (apps/desktop/src/main/index.ts). Requests go out without cookies, only to
// public HTTPS addresses, with every redirect checked, and the address a name
// leads to is checked as the connection is made, so it can't change in between.

const (
	// However many addresses ask, and however often one does over a day.
	previewsPerSecond = 20
	previewBurst      = 100
	previewsPerDay    = 2000

	previewMaxBytes     = 5 << 20
	previewMaxRedirects = 5
	previewTimeout      = 10 * time.Second
	previewUserAgent    = "Mozilla/5.0 (compatible; Zuna link preview)"
)

var errNotPublic = errors.New("not a public address")

func lookup(ctx context.Context, name string) ([]netip.Addr, error) {
	if addr, err := netip.ParseAddr(name); err == nil {
		return []netip.Addr{addr}, nil
	}
	return net.DefaultResolver.LookupNetIP(ctx, "ip", name)
}

// dial connects to an address a name leads to, after checking all of them.
func (h *host) dial(ctx context.Context, network, address string) (net.Conn, error) {
	name, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	addrs, err := h.resolve(ctx, name)
	if err != nil {
		return nil, err
	}
	if len(addrs) == 0 {
		return nil, fmt.Errorf("%s has no address", name)
	}
	local := h.cfg.AllowLocal && devHost(name)
	for _, addr := range addrs {
		if !local && privateAddress(addr) {
			return nil, errNotPublic
		}
	}
	var dialer net.Dialer
	var last error
	for _, addr := range addrs {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr.Unmap().String(), port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	return nil, last
}

func (h *host) newClient() *http.Client {
	transport := &http.Transport{
		Proxy:                 nil,
		DialContext:           h.dial,
		TLSClientConfig:       h.tlsConfig,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          20,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: previewTimeout,
	}
	return &http.Client{
		Transport: transport,
		Timeout:   previewTimeout,
		// No cookie jar: nothing is sent, and nothing a site sets is kept.
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > previewMaxRedirects {
				return errors.New("too many redirects")
			}
			if !h.previewable(req.URL) {
				return errNotPublic
			}
			return nil
		},
	}
}

// previewType is what a preview can use: a page, or a picture.
func previewType(contentType string) bool {
	media, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return media == "text/html" || media == "application/xhtml+xml" || strings.HasPrefix(media, "image/")
}

func (h *host) handlePreview(w http.ResponseWriter, r *http.Request) {
	// The page's own worker sends this header. A page on another site can't
	// without asking first, and nothing here answers that question.
	if r.Header.Get("X-Zuna-Preview") != "1" {
		http.Error(w, "Not allowed", http.StatusForbidden)
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		http.Error(w, "Not allowed", http.StatusForbidden)
		return
	}
	// Scripts can send those headers too, so anyone can use this to fetch public pages
	// with this host's address taking the blame. These are what stops that being worth it.
	caller := clientip.Key(h.ip.Address(r))
	if !h.limiter.Allow(caller) || !h.daily.Allow(caller) || !h.overall.Allow() {
		http.Error(w, "Too many previews. Please wait a moment.", http.StatusTooManyRequests)
		return
	}
	query := r.URL.Query()
	maxBytes, _ := strconv.Atoi(query.Get("max"))
	maxBytes = min(maxBytes, previewMaxBytes)
	target, err := url.Parse(query.Get("url"))
	if err != nil || maxBytes <= 0 || !h.previewable(target) {
		http.Error(w, "Not allowed", http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), previewTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		http.Error(w, "Not allowed", http.StatusBadRequest)
		return
	}
	req.Header.Set("User-Agent", previewUserAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.5")
	resp, err := h.client.Do(req)
	if err != nil {
		http.Error(w, "Not available", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	contentType := resp.Header.Get("Content-Type")
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !previewType(contentType) {
		http.Error(w, "Not available", http.StatusBadGateway)
		return
	}
	// Only as much as a preview needs, however large the page is.
	body, err := io.ReadAll(io.LimitReader(resp.Body, int64(maxBytes)))
	if err != nil {
		http.Error(w, "Not available", http.StatusBadGateway)
		return
	}

	headers := w.Header()
	headers.Set("Content-Type", contentType)
	headers.Set("X-Zuna-Url", resp.Request.URL.String())
	headers.Set("Cache-Control", "no-store")
	// Someone else's page, on this site's address: it must never run as a page here.
	headers.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	headers.Set("Content-Disposition", "attachment")
	headers.Set("Content-Length", strconv.Itoa(len(body)))
	_, _ = w.Write(body)
}
