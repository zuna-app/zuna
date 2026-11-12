package main

import (
	"bytes"
	"context"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func env(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func TestParseFlags(t *testing.T) {
	cfg, showVersion, err := parseFlags(nil, env(nil))
	if err != nil || showVersion || cfg.listen != ":8080" || cfg.previews != "on" || cfg.dataDir != "./zuna-web-data" {
		t.Fatalf("defaults: %+v %v %v", cfg, showVersion, err)
	}
	cfg, _, _ = parseFlags([]string{"-domain", "web.example.com"}, env(nil))
	if cfg.listen != "" {
		t.Fatalf("a domain listens on its own ports, not %q", cfg.listen)
	}
	cfg, _, _ = parseFlags(nil, env(map[string]string{"ZUNA_WEB_LISTEN": "127.0.0.1:1", "ZUNA_WEB_TRUST_PROXY": "true", "ZUNA_WEB_BEHIND_CLOUDFLARE": "1", "ZUNA_WEB_PREVIEWS": "off", "ZUNA_WEB_SERVERS": "https://a.example/,https://b.example"}))
	if cfg.listen != "127.0.0.1:1" || !cfg.trustProxy || !cfg.cloudflare || cfg.previews != "off" || cfg.servers != "https://a.example/,https://b.example" {
		t.Fatalf("from the environment: %+v", cfg)
	}
	if _, showVersion, _ := parseFlags([]string{"-version"}, env(nil)); !showVersion {
		t.Fatal("-version wasn't seen")
	}
	if _, _, err := parseFlags([]string{"-nope"}, env(nil)); err == nil {
		t.Fatal("an unknown flag was taken")
	}
	if got := splitList(" https://a.example/ ,, https://b.example"); strings.Join(got, "|") != "https://a.example|https://b.example" {
		t.Fatalf("splitList: %q", got)
	}
}

// app is a folder with a built app in it.
func app(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<!doctype html><title>Zuna</title>"), 0o600)
	return dir
}

func TestAppFiles(t *testing.T) {
	if files, err := appFiles(config{root: app(t)}); err != nil || files == nil {
		t.Fatalf("a built app: %v", err)
	}
	empty := t.TempDir()
	if _, err := appFiles(config{root: empty}); err == nil || !strings.Contains(err.Error(), "has no index.html") {
		t.Fatalf("a folder without the app: %v", err)
	}
	if files, err := appFiles(config{root: empty, dev: true}); err != nil || files != nil {
		t.Fatalf("development without the app: %v %v", files, err)
	}
	// The copy built in, which a plain checkout hasn't got.
	files, err := appFiles(config{})
	if _, built := fs.Stat(site, "site/index.html"); built == nil {
		if err != nil || files == nil {
			t.Fatalf("the built-in app: %v", err)
		}
	} else if err == nil || !strings.Contains(err.Error(), "no web app in it") {
		t.Fatalf("no built-in app: %v", err)
	}
}

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

func freeAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().String()
}

func TestRunServesTheAppAndStops(t *testing.T) {
	address := freeAddress(t)
	cfg, _, _ := parseFlags([]string{"-root", app(t), "-listen", address, "-servers", "https://chat.example.com/", "-server", "https://chat.example.com/"}, env(nil))
	ctx, cancel := context.WithCancel(context.Background())
	out := &buffer{}
	done := make(chan error, 1)
	go func() { done <- run(ctx, cfg, out) }()
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get("http://" + address + "/")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("the app: %d", resp.StatusCode)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("stopping: %v", err)
	}
	for _, said := range []string{"open http://" + address, "Browsers only run Zuna over HTTPS", "Link previews: on", "Only these servers: https://chat.example.com"} {
		if !strings.Contains(out.String(), said) {
			t.Errorf("the banner doesn't say %q:\n%s", said, out)
		}
	}
}

func TestRunRefusesWhatItCant(t *testing.T) {
	root := app(t)
	for _, c := range []struct {
		name string
		args []string
	}{
		{"previews that are neither on nor off", []string{"-previews", "maybe"}},
		{"no app", []string{"-root", t.TempDir()}},
		{"a proxy that isn't an address", []string{"-trusted-proxies", "nonsense"}},
		{"a server that isn't one", []string{"-servers", "not a server"}},
		{"a certificate it can't read", []string{"-tls-cert", filepath.Join(root, "missing.pem"), "-tls-key", filepath.Join(root, "missing.key")}},
	} {
		t.Run(c.name, func(t *testing.T) {
			args := append([]string{"-root", root, "-listen", freeAddress(t)}, c.args...)
			cfg, _, err := parseFlags(args, env(nil))
			if err != nil {
				t.Fatal(err)
			}
			if err := run(context.Background(), cfg, &buffer{}); err == nil {
				t.Fatal("it ran")
			}
		})
	}
}

func TestBanner(t *testing.T) {
	out := &buffer{}
	printBanner(out, config{previews: "off", dev: true}, false, "http", ":8080", nil)
	if !strings.Contains(out.String(), "Listening on :8080, without the app's files (development)") || strings.Contains(out.String(), "Browsers only") {
		t.Fatalf("development: %s", out)
	}
	out = &buffer{}
	printBanner(out, config{domain: "web.example.com", previews: "on"}, true, "https", ":443", nil)
	if !strings.Contains(out.String(), "open https://web.example.com") {
		t.Fatalf("a domain: %s", out)
	}
	out = &buffer{}
	printBanner(out, config{previews: "on"}, true, "http", "[::]:8080", nil)
	if !strings.Contains(out.String(), "open http://localhost:8080") {
		t.Fatalf("every address: %s", out)
	}
}
