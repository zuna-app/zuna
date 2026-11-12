package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"flag"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"zuna/server/internal/relay"
)

func env(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

// p8 is an APNs token key as Apple's developer site gives one.
func p8(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "AuthKey.p8")
	os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)
	return path
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

func TestVersionAndHelp(t *testing.T) {
	out := &bytes.Buffer{}
	if err := run(context.Background(), []string{"-version"}, env(nil), out); err != nil || strings.TrimSpace(out.String()) != version {
		t.Fatalf("-version: %v %q", err, out)
	}
	if err := run(context.Background(), []string{"-h"}, env(nil), out); !errors.Is(err, flag.ErrHelp) {
		t.Fatalf("-h: %v", err)
	}
}

func TestRelaysUntilStopped(t *testing.T) {
	// Apple takes the key in production, refuses it in the sandbox.
	apple := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/sandbox") {
			w.WriteHeader(http.StatusForbidden)
			w.Write([]byte(`{"reason":"InvalidProviderToken"}`))
			return
		}
		w.WriteHeader(http.StatusGone)
		w.Write([]byte(`{"reason":"Unregistered"}`))
	}))
	defer apple.Close()
	apnsReady = func(apns *relay.APNs) {
		apns.Production = apple.URL
		apns.Sandbox = apple.URL + "/sandbox"
	}
	defer func() { apnsReady = func(*relay.APNs) {} }()

	address := freeAddress(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- run(ctx, nil, env(map[string]string{
			"ZUNA_PUSH_LISTEN": address, "ZUNA_PUSH_DATA": t.TempDir(), "ZUNA_PUSH_APNS_KEY": p8(t), "ZUNA_PUSH_APNS_KEY_ID": "ABC123",
			"ZUNA_PUSH_TRUST_PROXY": "true", "ZUNA_PUSH_TRUSTED_PROXIES": "10.0.0.1, ,10.0.0.0/8", "ZUNA_PUSH_BEHIND_CLOUDFLARE": "false",
		}), &bytes.Buffer{})
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		resp, err := http.Get("http://" + address + "/healthz")
		if err == nil {
			resp.Body.Close()
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
}

func TestRunsWithoutAKeyAndSaysWhenAppleCantBeReached(t *testing.T) {
	apnsReady = func(apns *relay.APNs) {
		apns.Production = "http://127.0.0.1:1"
		apns.Sandbox = "http://127.0.0.1:1"
	}
	defer func() { apnsReady = func(*relay.APNs) {} }()
	for _, args := range [][]string{
		{"-data", t.TempDir()},
		{"-data", t.TempDir(), "-apns-key", p8(t), "-apns-key-id", "K"},
	} {
		address := freeAddress(t)
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() { done <- run(ctx, append(args, "-listen", address), env(nil), &bytes.Buffer{}) }()
		time.Sleep(100 * time.Millisecond)
		cancel()
		if err := <-done; err != nil {
			t.Fatalf("%v: %v", args, err)
		}
	}
}

func TestRefusesWhatItCant(t *testing.T) {
	dir := t.TempDir()
	notKey := filepath.Join(dir, "not-a-key")
	os.WriteFile(notKey, []byte("hello"), 0o600)
	short := filepath.Join(t.TempDir(), "handle.key")
	os.WriteFile(short, []byte("too short"), 0o600)
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer taken.Close()
	for _, c := range []struct {
		name string
		args []string
	}{
		{"an unknown flag", []string{"-nope"}},
		{"a handle key of the wrong size", []string{"-data", filepath.Dir(short)}},
		{"a handle key that's a folder", []string{"-data", filepath.Join(dir, "x", "handle.key", "..")}},
		{"a data folder under a file", []string{"-data", filepath.Join(notKey, "inside")}},
		{"an APNs key that isn't there", []string{"-data", t.TempDir(), "-apns-key", filepath.Join(dir, "missing.p8")}},
		{"an APNs key that isn't one", []string{"-data", t.TempDir(), "-apns-key", notKey}},
		{"a proxy that isn't an address", []string{"-data", t.TempDir(), "-trusted-proxies", "nonsense"}},
		{"an address that's taken", []string{"-data", t.TempDir(), "-listen", taken.Addr().String()}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if c.name == "a handle key that's a folder" {
				os.MkdirAll(filepath.Join(dir, "x", "handle.key"), 0o700)
			}
			if err := run(context.Background(), c.args, env(nil), &bytes.Buffer{}); err == nil {
				t.Fatal("it ran")
			}
		})
	}
}

func TestHandleKeyLasts(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	first, err := loadHandleKey(dir)
	if err != nil || len(first) != 32 {
		t.Fatalf("making it: %v", err)
	}
	again, err := loadHandleKey(dir)
	if err != nil || !bytes.Equal(first, again) {
		t.Fatalf("reading it again: %v", err)
	}
}
