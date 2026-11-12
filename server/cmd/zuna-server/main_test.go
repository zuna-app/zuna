package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// env is an environment of only these variables.
func env(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func TestParseFlagsWorksOutWhereTheServerIs(t *testing.T) {
	for _, c := range []struct {
		name            string
		args            []string
		env             map[string]string
		listen, public  string
		wantIP          bool
		trust, cloudfl  bool
		quota           int
		dataDir, relays string
	}{
		{name: "defaults", listen: ":9660", public: "http://localhost:9660", dataDir: "./zuna-data", relays: defaultPushRelay},
		{name: "an IPv4 address", args: []string{"-domain", "192.168.1.5"}, listen: ":443", public: "https://192.168.1.5", wantIP: true},
		{name: "an IPv6 address on a port of its own", args: []string{"-domain", "[fd00::1]", "-listen", ":8443"}, listen: ":8443", public: "https://[fd00::1]:8443", wantIP: true},
		{name: "a domain", args: []string{"-domain", "chat.example.com"}, listen: "", public: "https://chat.example.com"},
		{name: "a certificate of its own", args: []string{"-tls-cert", "c.pem", "-tls-key", "k.pem", "-listen", ":7000"}, listen: ":7000", public: "https://localhost:7000"},
		{name: "a listen address without a port", args: []string{"-listen", "nonsense"}, listen: "nonsense", public: "http://localhost"},
		{name: "behind a proxy", args: []string{"-public-url", "https://chat.example.com///"}, listen: ":9660", public: "https://chat.example.com"},
		{
			name: "from the environment",
			env: map[string]string{
				"ZUNA_DATA": "/srv/zuna", "ZUNA_LISTEN": "127.0.0.1:9000", "ZUNA_TRUST_PROXY": "true", "ZUNA_BEHIND_CLOUDFLARE": "1",
				"ZUNA_USER_QUOTA_MB": "5", "ZUNA_PUSH_RELAYS": "off",
			},
			listen: "127.0.0.1:9000", public: "http://localhost:9000", trust: true, cloudfl: true, quota: 5, dataDir: "/srv/zuna", relays: "off",
		},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg, showVersion, err := parseFlags(c.args, env(c.env))
			if err != nil || showVersion {
				t.Fatalf("parseFlags: %v, version %v", err, showVersion)
			}
			if cfg.listen != c.listen || cfg.publicURL != c.public || (cfg.ip != nil) != c.wantIP {
				t.Fatalf("got listen %q, public %q, ip %v", cfg.listen, cfg.publicURL, cfg.ip)
			}
			if cfg.trustProxy != c.trust || cfg.cloudflare != c.cloudfl || cfg.userQuotaMB != c.quota {
				t.Fatalf("got trust %v, cloudflare %v, quota %d", cfg.trustProxy, cfg.cloudflare, cfg.userQuotaMB)
			}
			if c.dataDir != "" && cfg.dataDir != c.dataDir {
				t.Fatalf("data dir %q", cfg.dataDir)
			}
			if c.relays != "" && cfg.pushRelays != c.relays {
				t.Fatalf("relays %q", cfg.pushRelays)
			}
		})
	}
}

func TestParseFlagsVersionAndMistakes(t *testing.T) {
	if _, showVersion, err := parseFlags([]string{"-version"}, env(nil)); err != nil || !showVersion {
		t.Fatalf("-version gave %v, %v", showVersion, err)
	}
	if _, _, err := parseFlags([]string{"-no-such-flag"}, env(nil)); err == nil {
		t.Fatal("an unknown flag was taken")
	}
}

func TestSplitList(t *testing.T) {
	if got := splitList(" https://a.example/ , ,https://b.example// "); strings.Join(got, "|") != "https://a.example|https://b.example" {
		t.Fatalf("got %q", got)
	}
	if got := splitList(" off "); got != nil {
		t.Fatalf("off gave %q", got)
	}
}

// buffer is what the server prints, read while it runs.
type buffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *buffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *buffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// freeAddress is an address on this machine nothing listens on.
func freeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().String()
}

// serve runs the server until the test is done with it, once it has printed want.
func serve(t *testing.T, cfg config, want string) (*buffer, func() error) {
	t.Helper()
	// Not the real 7TV, which the background loops would fetch from.
	t.Setenv("ZUNA_7TV_API", "http://127.0.0.1:1")
	t.Setenv("ZUNA_7TV_CDN", "http://127.0.0.1:1")
	ctx, cancel := context.WithCancel(context.Background())
	out := &buffer{}
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, out) }()
	deadline := time.Now().Add(10 * time.Second)
	for !strings.Contains(out.String(), want) {
		select {
		case err := <-done:
			cancel()
			t.Fatalf("the server stopped before saying %q: %v\n%s", want, err, out)
		default:
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatalf("the server never said %q:\n%s", want, out)
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop := func() error {
		cancel()
		select {
		case err := <-done:
			return err
		case <-time.After(15 * time.Second):
			t.Fatal("the server didn't stop")
			return nil
		}
	}
	return out, stop
}

func TestRunServesAndStops(t *testing.T) {
	address := freeAddress(t)
	cfg, _, err := parseFlags([]string{"-data", t.TempDir(), "-listen", address, "-livekit-keys", filepath.Join(t.TempDir(), "livekit.yaml")}, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	out, stop := serve(t, cfg, "/invite/")
	for _, said := range []string{"Listening on " + address, "Phone notifications go through: " + defaultPushRelay, "Finish setup"} {
		if !strings.Contains(out.String(), said) {
			t.Errorf("the banner doesn't say %q:\n%s", said, out)
		}
	}
	resp, err := http.Get("http://" + address + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %d", resp.StatusCode)
	}
	if err := stop(); err != nil {
		t.Fatalf("stopping: %v", err)
	}
}

// An address something else holds fails before the banner says it's listening.
func TestRunRefusesAnAddressInUse(t *testing.T) {
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	cfg, _, err := parseFlags([]string{"-data", t.TempDir(), "-listen", taken.Addr().String(), "-livekit-keys", filepath.Join(t.TempDir(), "livekit.yaml"), "-push-relays", "off"}, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var out bytes.Buffer
	err = run(ctx, cfg, &out)
	if err == nil || !strings.Contains(err.Error(), "listening on "+taken.Addr().String()) {
		t.Fatalf("run: %v", err)
	}
	if strings.Contains(out.String(), "Listening on") {
		t.Errorf("the banner said it was listening:\n%s", out.String())
	}
}

func TestRunWithItsOwnCertificate(t *testing.T) {
	address := freeAddress(t)
	cfg, _, err := parseFlags([]string{"-data", t.TempDir(), "-domain", "127.0.0.1", "-listen", address, "-push-relays", "off"}, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	out, stop := serve(t, cfg, "#pin=")
	if strings.Contains(out.String(), "Phone notifications") {
		t.Errorf("relays were off:\n%s", out)
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	resp, err := client.Get("https://" + address + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if err := stop(); err != nil {
		t.Fatalf("stopping: %v", err)
	}
}

func TestRunWithACertificateItsGiven(t *testing.T) {
	dir := t.TempDir()
	key, err := certificateKey(filepath.Join(dir, "key"))
	if err != nil {
		t.Fatal(err)
	}
	made, err := makeCertificate(key, net.ParseIP("127.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPath, keyPath := filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")
	os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: made.Certificate[0]}), 0o600)
	os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: der}), 0o600)
	address := freeAddress(t)
	cfg, _, err := parseFlags([]string{"-data", dir, "-tls-cert", certPath, "-tls-key", keyPath, "-listen", address, "-push-relays", "off"}, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	_, stop := serve(t, cfg, "/invite/")
	if err := stop(); err != nil {
		t.Fatalf("stopping: %v", err)
	}

	// One it can't read stops it.
	cfg.tlsCert = filepath.Join(dir, "missing.pem")
	cfg.listen = freeAddress(t)
	if err := run(context.Background(), cfg, &buffer{}); err == nil {
		t.Fatal("a missing certificate was taken")
	}
}

func TestRunStartsTheLogOfKeysAgain(t *testing.T) {
	cfg, _, err := parseFlags([]string{"-data", t.TempDir(), "-new-log-era"}, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	out := &buffer{}
	if err := run(context.Background(), cfg, out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "The log of keys is in era") {
		t.Fatalf("it said %q", out)
	}
}

func TestRunRefusesWhatItCant(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "a-file")
	os.WriteFile(file, []byte("x"), 0o600)
	for _, c := range []struct {
		name string
		args []string
	}{
		{"a data folder that's a file", []string{"-data", file}},
		{"two sources of LiveKit's keys", []string{"-data", dir, "-livekit-keys", filepath.Join(dir, "k"), "-livekit-key", "k"}},
		{"a LiveKit key file that's a folder", []string{"-data", dir, "-livekit-keys", dir}},
		{"a database that isn't one", []string{"-data", dir, "-database-url", "postgres://%zz"}},
		{"a database it can't open", []string{"-data", file + "-dir", "-database-url", ""}},
		{"a proxy that isn't an address", []string{"-data", dir, "-trusted-proxies", "not-an-address"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			cfg, _, err := parseFlags(append(c.args, "-listen", "127.0.0.1:0"), env(nil))
			if err != nil {
				t.Fatal(err)
			}
			if c.name == "a database it can't open" {
				// A folder where the database file should be.
				os.MkdirAll(filepath.Join(cfg.dataDir, "zuna.db"), 0o700)
			}
			if err := run(context.Background(), cfg, &buffer{}); err == nil {
				t.Fatal("it ran")
			}
		})
	}
}

func TestKeyFilesThatCantBeReadOrWritten(t *testing.T) {
	dir := t.TempDir()
	if _, err := certificateKey(dir); err == nil {
		t.Fatal("a folder was taken for the certificate's key")
	}
	if _, err := certificateKey(filepath.Join(dir, "missing", "certificate.key")); err == nil {
		t.Fatal("a key was made where it can't be kept")
	}
	if _, _, err := liveKitKeys(filepath.Join(dir, "missing", "livekit.yaml")); err == nil {
		t.Fatal("LiveKit's keys were made where they can't be kept")
	}
	if _, _, err := ownCertificate(dir, net.ParseIP("127.0.0.1")); err == nil {
		t.Fatal("a certificate was made from a folder")
	}
}

func TestRunWithADomain(t *testing.T) {
	https, http80 := freeAddress(t), freeAddress(t)
	httpsAddress, httpAddress = https, http80
	defer func() { httpsAddress, httpAddress = ":443", ":80" }()
	cfg, _, err := parseFlags([]string{"-data", t.TempDir(), "-domain", "chat.example.com", "-push-relays", "off"}, env(nil))
	if err != nil {
		t.Fatal(err)
	}
	out, stop := serve(t, cfg, "/invite/")
	if !strings.Contains(out.String(), "Listening on "+https+", reachable at https://chat.example.com") {
		t.Errorf("the banner: %s", out)
	}
	// The redirect to HTTPS answers, for the domain alone.
	resp, err := noRedirects.Get("http://" + http80 + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if err := stop(); err != nil {
		t.Fatalf("stopping: %v", err)
	}
}

// noRedirects is a client that stops at a redirect, as the one to HTTPS goes to a port nothing here serves.
var noRedirects = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
