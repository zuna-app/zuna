// Package webhost serves Zuna's web app: its files, with the headers that keep
// it safe, and the link previews a page can't fetch for itself. It knows nothing
// about chat servers and keeps nothing of anyone's.
package webhost

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"

	"zuna/server/internal/clientip"
	"zuna/server/internal/ratelimit"
)

// Config is how one web app is served.
type Config struct {
	// Files is the built app (apps/web/dist). Nil serves only the API, for development.
	Files fs.FS
	// Previews turns on fetching pages for link previews.
	Previews bool
	// Server is filled in on the sign-in form.
	Server string
	// Servers, if any, are the only servers the app may connect to.
	Servers []string
	// MediaServers are the LiveKit servers it may connect to as well, for those
	// servers' voice channels, where they aren't reached through the server itself.
	MediaServers []string
	// AllowLocal lets previews reach this machine, for development only.
	AllowLocal bool
	// ClientIP says who is calling, for rate limits. Nil trusts no proxy.
	ClientIP *clientip.Resolver
}

type file struct {
	body        []byte
	gzipped     []byte
	contentType string
	etag        string
	immutable   bool
}

type host struct {
	cfg       Config
	files     map[string]*file
	csp       string
	ip        *clientip.Resolver
	limiter   *ratelimit.Keyed
	daily     *ratelimit.Keyed
	overall   *rate.Limiter
	client    *http.Client
	resolve   func(ctx context.Context, name string) ([]netip.Addr, error)
	tlsConfig *tls.Config
}

// New makes the handler for a web app.
func New(cfg Config) (http.Handler, error) {
	h, err := newHost(cfg)
	if err != nil {
		return nil, err
	}
	return h.handler(), nil
}

func newHost(cfg Config) (*host, error) {
	for _, server := range cfg.Servers {
		if _, err := serverOrigin(server); err != nil {
			return nil, err
		}
	}
	h := &host{
		cfg:     cfg,
		csp:     contentSecurityPolicy(cfg.Servers, cfg.MediaServers),
		ip:      cfg.ClientIP,
		limiter: ratelimit.NewKeyed(rate.Every(2*time.Second), 30),
		daily:   ratelimit.NewKeyed(rate.Every(24*time.Hour/previewsPerDay), previewsPerDay),
		overall: rate.NewLimiter(previewsPerSecond, previewBurst),
		resolve: lookup,
	}
	if h.ip == nil {
		h.ip = &clientip.Resolver{}
	}
	if cfg.Files != nil {
		if err := h.load(cfg.Files); err != nil {
			return nil, err
		}
	}
	h.client = h.newClient()
	return h, nil
}

func (h *host) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write([]byte("ok\n"))
	})
	mux.HandleFunc("GET /_zuna/config", h.handleConfig)
	if h.cfg.Previews {
		mux.HandleFunc("GET /_zuna/preview", h.handlePreview)
	}
	mux.HandleFunc("GET /", h.handleFile)
	return h.withHeaders(mux)
}

// serverOrigin is a server address's scheme and host, which is what the content
// security policy can name.
func serverOrigin(server string) (*url.URL, error) {
	parsed, err := url.Parse(server)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return nil, fmt.Errorf("%q isn't a server address, such as https://chat.example.com", server)
	}
	return &url.URL{Scheme: parsed.Scheme, Host: parsed.Host}, nil
}

// contentSecurityPolicy is the desktop's (apps/desktop/src/main/index.ts), with
// connections narrowed to the allowed servers when there are any.
func contentSecurityPolicy(servers, mediaServers []string) string {
	connect := "'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*"
	if len(servers) > 0 {
		sources := []string{"'self'"}
		for _, server := range append(append([]string{}, servers...), mediaServers...) {
			origin, _ := serverOrigin(server)
			socket := "wss"
			if origin.Scheme == "http" {
				socket = "ws"
			}
			sources = append(sources, origin.String(), socket+"://"+origin.Host)
		}
		connect = strings.Join(sources, " ")
	}
	return strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		// Images are never fetched by address. Emotes and icons from a joined server are
		// fetched first and shown from memory, and everything else is decrypted or inline,
		// so nothing in a message can make this app contact anyone.
		"img-src 'self' data: blob:",
		"media-src 'self' blob:",
		"font-src 'self'",
		"connect-src " + connect,
		"worker-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"frame-src 'none'",
		"frame-ancestors 'none'",
	}, "; ")
}

// hostOf is the name a request was addressed to, without its port.
func hostOf(r *http.Request) string {
	if name, _, err := net.SplitHostPort(r.Host); err == nil {
		return name
	}
	return r.Host
}

func (h *host) withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers := w.Header()
		headers.Set("Content-Security-Policy", h.csp)
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("Referrer-Policy", "no-referrer")
		headers.Set("X-Frame-Options", "DENY")
		headers.Set("Cross-Origin-Opener-Policy", "same-origin")
		headers.Set("Cross-Origin-Resource-Policy", "same-origin")
		headers.Set("Permissions-Policy", "microphone=(self), camera=(self), geolocation=(self), payment=(), usb=(), display-capture=(self), speaker-selection=(self)")
		// Behind a proxy there's no telling how a request arrived, but browsers ignore
		// this over plain HTTP. Only for this machine would it stick to something else.
		if !devHost(hostOf(r)) {
			headers.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

func (h *host) handleConfig(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]any{"previews": h.cfg.Previews, "server": h.cfg.Server, "localLinks": h.cfg.AllowLocal})
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".wasm":  "application/wasm",
	".svg":   "image/svg+xml",
	".png":   "image/png",
	".woff2": "font/woff2",
	".woff":  "font/woff",
	".txt":   "text/plain; charset=utf-8",
}

// load reads the whole app into memory, compressed where that helps, so serving
// a file never touches the disk.
func (h *host) load(files fs.FS) error {
	h.files = map[string]*file{}
	err := fs.WalkDir(files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || strings.HasPrefix(path.Base(name), ".") {
			return err
		}
		body, err := fs.ReadFile(files, name)
		if err != nil {
			return err
		}
		ext := path.Ext(name)
		contentType := contentTypes[ext]
		if contentType == "" {
			contentType = mime.TypeByExtension(ext)
		}
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		sum := sha256.Sum256(body)
		f := &file{
			body:        body,
			contentType: contentType,
			etag:        `"` + hex.EncodeToString(sum[:12]) + `"`,
			// Vite names these after their contents, so they never change.
			immutable: strings.HasPrefix(name, "assets/"),
		}
		if compressible(contentType) && len(body) > 1024 {
			var buf bytes.Buffer
			writer, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
			_, _ = writer.Write(body)
			_ = writer.Close()
			if buf.Len() < len(body)*9/10 {
				f.gzipped = buf.Bytes()
			}
		}
		h.files[name] = f
		return nil
	})
	if err != nil {
		return err
	}
	if h.files["index.html"] == nil {
		return errors.New("the web app's files have no index.html")
	}
	return nil
}

func compressible(contentType string) bool {
	return strings.HasPrefix(contentType, "text/") || strings.HasPrefix(contentType, "application/") || strings.HasPrefix(contentType, "image/svg")
}

func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		coding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.EqualFold(strings.TrimSpace(coding), "gzip") && strings.ReplaceAll(params, " ", "") != "q=0" {
			return true
		}
	}
	return false
}

func (h *host) handleFile(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	f := h.files[name]
	if f == nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}
	headers := w.Header()
	headers.Set("Content-Type", f.contentType)
	headers.Set("ETag", f.etag)
	headers.Set("Vary", "Accept-Encoding")
	if f.immutable {
		headers.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		// Checked on every visit, so a new version reaches everyone.
		headers.Set("Cache-Control", "no-cache")
	}
	if r.Header.Get("If-None-Match") == f.etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body := f.body
	if f.gzipped != nil && acceptsGzip(r) {
		headers.Set("Content-Encoding", "gzip")
		body = f.gzipped
	}
	headers.Set("Content-Length", strconv.Itoa(len(body)))
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(body)
}
