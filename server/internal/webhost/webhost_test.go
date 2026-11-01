package webhost

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

func testFiles() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte("<!doctype html><title>Zuna</title>")},
		"version.json":           {Data: []byte(`{"build":"abc"}`)},
		"favicon.svg":            {Data: []byte("<svg></svg>")},
		"assets/index-abc.js":    {Data: bytes.Repeat([]byte("console.log('zuna');\n"), 400)},
		"assets/crypto-abc.wasm": {Data: []byte("\x00asm")},
		".hidden":                {Data: []byte("secret")},
	}
}

func newTestHost(t *testing.T, cfg Config) *host {
	t.Helper()
	if cfg.Files == nil {
		cfg.Files = testFiles()
	}
	h, err := newHost(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func get(t *testing.T, handler http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestEveryFileHasTheSecurityHeaders(t *testing.T) {
	handler := newTestHost(t, Config{}).handler()
	for _, target := range []string{"/", "/index.html", "/assets/index-abc.js", "/assets/crypto-abc.wasm", "/version.json", "/missing", "/_zuna/config"} {
		rec := get(t, handler, target, nil)
		headers := rec.Header()
		csp := headers.Get("Content-Security-Policy")
		for _, want := range []string{"default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "frame-ancestors 'none'", "object-src 'none'", "img-src 'self' data: blob:"} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s: the policy lacks %q: %s", target, want, csp)
			}
		}
		for name, want := range map[string]string{
			"X-Content-Type-Options":       "nosniff",
			"Referrer-Policy":              "no-referrer",
			"X-Frame-Options":              "DENY",
			"Cross-Origin-Opener-Policy":   "same-origin",
			"Cross-Origin-Resource-Policy": "same-origin",
		} {
			if got := headers.Get(name); got != want {
				t.Errorf("%s: %s is %q, want %q", target, name, got, want)
			}
		}
		if !strings.Contains(headers.Get("Permissions-Policy"), "microphone=(self)") {
			t.Errorf("%s: the microphone isn't allowed for voice messages", target)
		}
	}
}

func TestFilesAreServedAndCachedRightly(t *testing.T) {
	handler := newTestHost(t, Config{}).handler()

	index := get(t, handler, "/", nil)
	if index.Code != http.StatusOK || !strings.Contains(index.Body.String(), "<title>Zuna</title>") {
		t.Fatalf("index: %d %q", index.Code, index.Body.String())
	}
	if got := index.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("index.html should be checked on every visit, got %q", got)
	}
	if got := get(t, handler, "/version.json", nil).Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("version.json should be checked every time, got %q", got)
	}

	script := get(t, handler, "/assets/index-abc.js", nil)
	if got := script.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("hashed files should be kept, got %q", got)
	}
	if got := script.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/javascript") {
		t.Errorf("script type %q", got)
	}
	if got := get(t, handler, "/assets/crypto-abc.wasm", nil).Header().Get("Content-Type"); got != "application/wasm" {
		t.Errorf("WebAssembly type %q", got)
	}

	gzipped := get(t, handler, "/assets/index-abc.js", map[string]string{"Accept-Encoding": "gzip, br"})
	if gzipped.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("a large script wasn't compressed")
	}
	reader, err := gzip.NewReader(gzipped.Body)
	if err != nil {
		t.Fatal(err)
	}
	plain, _ := io.ReadAll(reader)
	if !bytes.Equal(plain, script.Body.Bytes()) {
		t.Error("the compressed script isn't the script")
	}

	etag := index.Header().Get("ETag")
	if again := get(t, handler, "/", map[string]string{"If-None-Match": etag}); again.Code != http.StatusNotModified {
		t.Errorf("an unchanged index.html should be %d, got %d", http.StatusNotModified, again.Code)
	}

	for _, target := range []string{"/missing.js", "/.hidden", "/index.html/x", "/assets/"} {
		if rec := get(t, handler, target, nil); rec.Code != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", target, rec.Code)
		}
	}
}

func TestAnAppNeedsItsIndex(t *testing.T) {
	if _, err := newHost(Config{Files: fstest.MapFS{"app.js": {Data: []byte("x")}}}); err == nil {
		t.Fatal("files without index.html were accepted")
	}
}

func TestConfigSaysWhatTheHostDoes(t *testing.T) {
	handler := newTestHost(t, Config{Previews: true, Server: "https://chat.example.com"}).handler()
	var config struct {
		Previews   bool   `json:"previews"`
		Server     string `json:"server"`
		LocalLinks bool   `json:"localLinks"`
	}
	if err := json.Unmarshal(get(t, handler, "/_zuna/config", nil).Body.Bytes(), &config); err != nil {
		t.Fatal(err)
	}
	if !config.Previews || config.Server != "https://chat.example.com" || config.LocalLinks {
		t.Errorf("config %+v", config)
	}
}

func TestAllowedServersNarrowConnections(t *testing.T) {
	handler := newTestHost(t, Config{Servers: []string{"https://chat.example.com", "http://localhost:8787"}}).handler()
	csp := get(t, handler, "/", nil).Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "connect-src 'self' https://chat.example.com wss://chat.example.com http://localhost:8787 ws://localhost:8787;") {
		t.Errorf("connections weren't narrowed: %s", csp)
	}
	if strings.Contains(csp, "https: ") {
		t.Errorf("any server is still allowed: %s", csp)
	}
	if _, err := newHost(Config{Files: testFiles(), Servers: []string{"chat.example.com"}}); err == nil {
		t.Error("a server without a scheme was accepted")
	}
}

func TestPreviewsAreOffUnlessAskedFor(t *testing.T) {
	handler := newTestHost(t, Config{}).handler()
	rec := get(t, handler, "/_zuna/preview?url=https://example.com/&max=100", map[string]string{"X-Zuna-Preview": "1"})
	if rec.Code != http.StatusNotFound {
		t.Errorf("got %d with previews off", rec.Code)
	}
}

func TestPreviewsOnlyServeThisSitesOwnPage(t *testing.T) {
	handler := newTestHost(t, Config{Previews: true}).handler()
	cases := map[string]map[string]string{
		"without the header":  {},
		"from another site":   {"X-Zuna-Preview": "1", "Sec-Fetch-Site": "cross-site"},
		"from a sibling site": {"X-Zuna-Preview": "1", "Sec-Fetch-Site": "same-site"},
		"opened as a page":    {"Sec-Fetch-Site": "none"},
	}
	for name, headers := range cases {
		if rec := get(t, handler, "/_zuna/preview?url=https://example.com/&max=100", headers); rec.Code != http.StatusForbidden {
			t.Errorf("%s: got %d, want 403", name, rec.Code)
		}
	}
}

func TestPreviewsOnlyReachPublicHTTPS(t *testing.T) {
	h := newTestHost(t, Config{Previews: true})
	refused := []string{
		"http://example.com/",
		"https://127.0.0.1/",
		"https://10.1.2.3/",
		"https://192.168.1.1/",
		"https://172.16.0.1/",
		"https://100.64.0.1/",
		"https://169.254.169.254/latest/meta-data/",
		"https://0.0.0.0/",
		"https://224.0.0.1/",
		"https://[::1]/",
		"https://[fd00::1]/",
		"https://[fe80::1]/",
		"https://[::ffff:127.0.0.1]/",
		"https://[64:ff9b::a00:1]/",
		"https://localhost/",
		"https://app.localhost/",
		"https://printer.local/",
		"https://intranet/",
		"https://nas.home.arpa/",
		"https://example.com:8443/",
		"https://user:pass@example.com/",
		"file:///etc/passwd",
	}
	for _, link := range refused {
		parsed, err := url.Parse(link)
		if err != nil {
			t.Fatal(err)
		}
		if h.previewable(parsed) {
			t.Errorf("%s was allowed", link)
		}
	}
	for _, link := range []string{"https://example.com/page?x=1", "https://93.184.215.14/", "https://example.com:443/", "https://[2606:4700::1111]/"} {
		parsed, _ := url.Parse(link)
		if !h.previewable(parsed) {
			t.Errorf("%s was refused", link)
		}
	}
}

// Z-59: a script can ask as well as the app can, so there's a limit to what it gets.
func TestPreviewsAreLimitedOverall(t *testing.T) {
	h := newTestHost(t, Config{Previews: true, AllowLocal: true})
	handler := h.handler()
	limited := 0
	for i := range 200 {
		request := httptest.NewRequest("GET", "/_zuna/preview?url=https%3A%2F%2Fexample.com%2F&max=0", nil)
		request.Header.Set("X-Zuna-Preview", "1")
		request.RemoteAddr = "198.51." + strconv.Itoa(i/256) + "." + strconv.Itoa(i%256) + ":1234"
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited == 0 {
		t.Fatal("200 previews from 200 addresses weren't limited")
	}
}

// Z-54: the same list the clients go by.
func TestPrivateAddressesMatchTheClients(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "e2e", "fixtures", "addresses.json"))
	if err != nil {
		t.Fatal(err)
	}
	var addresses struct {
		Private []string `json:"private"`
		Public  []string `json:"public"`
	}
	if err := json.Unmarshal(data, &addresses); err != nil {
		t.Fatal(err)
	}
	for _, address := range addresses.Private {
		if !privateAddress(netip.MustParseAddr(address)) {
			t.Errorf("%s counted as public", address)
		}
	}
	for _, address := range addresses.Public {
		if privateAddress(netip.MustParseAddr(address)) {
			t.Errorf("%s counted as private", address)
		}
	}
}

// Z-51: behind a proxy this can't tell how a request arrived, and browsers only heed this over HTTPS.
func TestStrictTransportIsSentExceptToThisMachine(t *testing.T) {
	h := newTestHost(t, Config{})
	next := http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})
	for host, want := range map[string]bool{"chat.example.com": true, "chat.example.com:8443": true, "localhost:5174": false, "app.localhost": false} {
		request := httptest.NewRequest("GET", "/", nil)
		request.Host = host
		recorder := httptest.NewRecorder()
		h.withHeaders(next).ServeHTTP(recorder, request)
		if got := recorder.Header().Get("Strict-Transport-Security") != ""; got != want {
			t.Errorf("%s: sent %v", host, got)
		}
	}
}

func TestPreviewsCheckWhereANameLeads(t *testing.T) {
	h := newTestHost(t, Config{Previews: true})
	h.resolve = func(_ context.Context, name string) ([]netip.Addr, error) {
		switch name {
		case "sneaky.example":
			return []netip.Addr{netip.MustParseAddr("93.184.215.14"), netip.MustParseAddr("127.0.0.1")}, nil
		case "rebound.example":
			return []netip.Addr{netip.MustParseAddr("10.0.0.7")}, nil
		}
		return nil, errors.New("no such name")
	}
	for _, name := range []string{"sneaky.example:443", "rebound.example:443"} {
		if _, err := h.dial(context.Background(), "tcp", name); !errors.Is(err, errNotPublic) {
			t.Errorf("%s: got %v, want a refusal", name, err)
		}
	}
	rec := get(t, h.handler(), "/_zuna/preview?url="+url.QueryEscape("https://rebound.example/")+"&max=100", map[string]string{"X-Zuna-Preview": "1", "Sec-Fetch-Site": "same-origin"})
	if rec.Code != http.StatusBadGateway {
		t.Errorf("a name leading to a private address got %d", rec.Code)
	}
}

// A development host may preview this machine, which is how this test reaches a page.
func previewSite(t *testing.T, handler http.HandlerFunc) (*host, *httptest.Server) {
	t.Helper()
	site := httptest.NewTLSServer(handler)
	t.Cleanup(site.Close)
	h := newTestHost(t, Config{Previews: true, AllowLocal: true})
	h.tlsConfig = site.Client().Transport.(*http.Transport).TLSClientConfig.Clone()
	h.client = h.newClient()
	return h, site
}

func preview(t *testing.T, h *host, link string, max int) *httptest.ResponseRecorder {
	t.Helper()
	target := "/_zuna/preview?url=" + url.QueryEscape(link) + "&max=" + strconv.Itoa(max)
	return get(t, h.handler(), target, map[string]string{"X-Zuna-Preview": "1", "Sec-Fetch-Site": "same-origin", "Cookie": "session=from-the-browser"})
}

func TestPreviewFetchesWithoutCookiesAndKeepsLittle(t *testing.T) {
	var sawCookie, sawAgent string
	h, site := previewSite(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/moved":
			http.Redirect(w, r, "/page", http.StatusFound)
		case "/page":
			sawCookie = r.Header.Get("Cookie")
			sawAgent = r.Header.Get("User-Agent")
			http.SetCookie(w, &http.Cookie{Name: "tracker", Value: "1"})
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte("<title>Hello</title>" + strings.Repeat("x", 10_000)))
		case "/file.zip":
			w.Header().Set("Content-Type", "application/zip")
			_, _ = w.Write([]byte("PK"))
		case "/away":
			http.Redirect(w, r, "https://10.0.0.1/", http.StatusFound)
		}
	})

	rec := preview(t, h, site.URL+"/moved", 100)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.Len() != 100 || !strings.HasPrefix(rec.Body.String(), "<title>Hello</title>") {
		t.Errorf("kept %d bytes: %q", rec.Body.Len(), rec.Body.String()[:min(40, rec.Body.Len())])
	}
	if got := rec.Header().Get("X-Zuna-Url"); got != site.URL+"/page" {
		t.Errorf("where it ended up: %q", got)
	}
	if rec.Header().Get("Set-Cookie") != "" {
		t.Error("the site's cookie was passed on")
	}
	if sawCookie != "" {
		t.Errorf("the site got a cookie: %q", sawCookie)
	}
	if sawAgent != previewUserAgent {
		t.Errorf("user agent %q", sawAgent)
	}
	if csp := rec.Header().Get("Content-Security-Policy"); !strings.Contains(csp, "sandbox") {
		t.Errorf("someone else's page could run here: %q", csp)
	}

	if rec := preview(t, h, site.URL+"/file.zip", 100); rec.Code != http.StatusBadGateway {
		t.Errorf("a file that's neither a page nor a picture got %d", rec.Code)
	}
	if rec := preview(t, h, site.URL+"/away", 100); rec.Code != http.StatusBadGateway {
		t.Errorf("a redirect to a private address got %d", rec.Code)
	}
	if rec := preview(t, h, site.URL+"/page", 0); rec.Code != http.StatusBadRequest {
		t.Errorf("no size got %d", rec.Code)
	}
}

func TestPreviewsAreRateLimited(t *testing.T) {
	handler := newTestHost(t, Config{Previews: true}).handler()
	limited := false
	for range 40 {
		rec := get(t, handler, "/_zuna/preview?url=http://not-allowed/&max=10", map[string]string{"X-Zuna-Preview": "1"})
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Error("40 previews at once weren't limited")
	}
}

func TestTheAppCanConnectToAMediaServerOnAnAllowList(t *testing.T) {
	csp := contentSecurityPolicy([]string{"https://chat.example"}, []string{"https://voice.example"})
	for _, source := range []string{"https://chat.example", "wss://chat.example", "wss://voice.example"} {
		if !strings.Contains(csp, source) {
			t.Errorf("%s isn't allowed by %q", source, csp)
		}
	}
	if csp := contentSecurityPolicy(nil, []string{"https://voice.example"}); strings.Contains(csp, "voice.example") {
		t.Errorf("with no list there's nothing to add to, but got %q", csp)
	}
}
