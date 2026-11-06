// zuna-push: the push relay Zuna servers use to wake phones running the
// published app. It holds the app's APNs key; see docs/PUSH_RELAY.md.
package main

import (
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"zuna/server/internal/clientip"
	"zuna/server/internal/relay"
)

var version = "dev"

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func main() {
	listen := flag.String("listen", envOr("ZUNA_PUSH_LISTEN", "127.0.0.1:8090"), "address to listen on, behind a reverse proxy that adds HTTPS (env ZUNA_PUSH_LISTEN)")
	data := flag.String("data", envOr("ZUNA_PUSH_DATA", "./zuna-push-data"), "folder for the key that seals handles (env ZUNA_PUSH_DATA)")
	keyFile := flag.String("apns-key", os.Getenv("ZUNA_PUSH_APNS_KEY"), "the APNs token key, a .p8 file (env ZUNA_PUSH_APNS_KEY)")
	keyID := flag.String("apns-key-id", os.Getenv("ZUNA_PUSH_APNS_KEY_ID"), "the APNs key's ID (env ZUNA_PUSH_APNS_KEY_ID)")
	teamID := flag.String("apns-team", envOr("ZUNA_PUSH_APNS_TEAM", "SGKB9R23YT"), "the Apple Developer team that publishes the app (env ZUNA_PUSH_APNS_TEAM)")
	topic := flag.String("apns-topic", envOr("ZUNA_PUSH_APNS_TOPIC", "chat.zuna.mobile"), "the app's bundle ID (env ZUNA_PUSH_APNS_TOPIC)")
	trustProxy, _ := strconv.ParseBool(os.Getenv("ZUNA_PUSH_TRUST_PROXY"))
	flag.BoolVar(&trustProxy, "trust-proxy", trustProxy, "take callers' addresses from X-Forwarded-For, when the connection comes from this machine or a private network (env ZUNA_PUSH_TRUST_PROXY)")
	trustedProxies := flag.String("trusted-proxies", os.Getenv("ZUNA_PUSH_TRUSTED_PROXIES"), "comma-separated addresses or CIDR ranges of reverse proxies to trust, instead of those networks (env ZUNA_PUSH_TRUSTED_PROXIES)")
	cloudflare, _ := strconv.ParseBool(os.Getenv("ZUNA_PUSH_BEHIND_CLOUDFLARE"))
	flag.BoolVar(&cloudflare, "behind-cloudflare", cloudflare, "take a request from Cloudflare's proxy to be from whoever it names in CF-Connecting-IP (env ZUNA_PUSH_BEHIND_CLOUDFLARE)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	handleKey, err := loadHandleKey(*data)
	if err != nil {
		fail("the handle key: %v", err)
	}
	var apns *relay.APNs
	if *keyFile != "" {
		p8, err := os.ReadFile(*keyFile)
		if err != nil {
			fail("reading the APNs key: %v", err)
		}
		if apns, err = relay.NewAPNs(p8, *keyID, *teamID, *topic); err != nil {
			fail("%v", err)
		}
	} else {
		slog.Warn("no APNs key: phones can't register, and pushes fail")
	}
	service, err := relay.New(handleKey, apns)
	if err != nil {
		fail("%v", err)
	}
	var proxies []string
	for _, proxy := range strings.Split(*trustedProxies, ",") {
		if proxy = strings.TrimSpace(proxy); proxy != "" {
			proxies = append(proxies, proxy)
		}
	}
	if service.Callers, err = clientip.New(trustProxy, proxies, cloudflare); err != nil {
		fail("%v", err)
	}
	server := &http.Server{Addr: *listen, Handler: service.Handler(), ReadTimeout: relay.ReadTimeout, WriteTimeout: relay.WriteTimeout}
	slog.Info("zuna-push listening", "address", *listen, "version", version)
	if err := server.ListenAndServe(); err != nil {
		fail("%v", err)
	}
}

// loadHandleKey reads the key handles are sealed with, making one on first start.
// Losing it breaks every phone's registration until the app registers again.
func loadHandleKey(dir string) ([]byte, error) {
	path := filepath.Join(dir, "handle.key")
	key, err := os.ReadFile(path)
	if err == nil && len(key) == 32 {
		return key, nil
	}
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, err
	}
	if err == nil {
		return nil, fmt.Errorf("%s isn't 32 bytes", path)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	key = make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return key, os.WriteFile(path, key, 0o600)
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "zuna-push: "+format+"\n", args...)
	os.Exit(1)
}
