// zuna-push: the push relay Zuna servers use to wake phones running the
// published app. It holds the app's APNs key; see docs/PUSH_RELAY.md.
package main

import (
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"zuna/server/internal/clientip"
	"zuna/server/internal/logs"
	"zuna/server/internal/relay"
)

var version = "dev"

// apnsReady is called with the APNs client before its key is checked, so that tests can
// point it at a stand-in for Apple.
var apnsReady = func(*relay.APNs) {}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:], os.Getenv, os.Stdout); err != nil {
		if !errors.Is(err, flag.ErrHelp) {
			fmt.Fprintf(os.Stderr, "zuna-push: %v\n", err)
			os.Exit(1)
		}
	}
}

// run relays pushes until ctx ends, with getenv giving what's in the environment.
func run(ctx context.Context, args []string, getenv func(string) string, out io.Writer) error {
	envOr := func(key, fallback string) string {
		if value := getenv(key); value != "" {
			return value
		}
		return fallback
	}
	flags := flag.NewFlagSet("zuna-push", flag.ContinueOnError)
	listen := flags.String("listen", envOr("ZUNA_PUSH_LISTEN", "127.0.0.1:8090"), "address to listen on, behind a reverse proxy that adds HTTPS (env ZUNA_PUSH_LISTEN)")
	data := flags.String("data", envOr("ZUNA_PUSH_DATA", "./zuna-push-data"), "folder for the key that seals handles (env ZUNA_PUSH_DATA)")
	keyFile := flags.String("apns-key", getenv("ZUNA_PUSH_APNS_KEY"), "the APNs token key, a .p8 file (env ZUNA_PUSH_APNS_KEY)")
	keyID := flags.String("apns-key-id", getenv("ZUNA_PUSH_APNS_KEY_ID"), "the APNs key's ID (env ZUNA_PUSH_APNS_KEY_ID)")
	teamID := flags.String("apns-team", envOr("ZUNA_PUSH_APNS_TEAM", "SGKB9R23YT"), "the Apple Developer team that publishes the app (env ZUNA_PUSH_APNS_TEAM)")
	topic := flags.String("apns-topic", envOr("ZUNA_PUSH_APNS_TOPIC", "chat.zuna.mobile"), "the app's bundle ID (env ZUNA_PUSH_APNS_TOPIC)")
	trustProxy, _ := strconv.ParseBool(getenv("ZUNA_PUSH_TRUST_PROXY"))
	flags.BoolVar(&trustProxy, "trust-proxy", trustProxy, "take callers' addresses from X-Forwarded-For, when the connection comes from this machine or a private network (env ZUNA_PUSH_TRUST_PROXY)")
	trustedProxies := flags.String("trusted-proxies", getenv("ZUNA_PUSH_TRUSTED_PROXIES"), "comma-separated addresses or CIDR ranges of reverse proxies to trust, instead of those networks (env ZUNA_PUSH_TRUSTED_PROXIES)")
	cloudflare, _ := strconv.ParseBool(getenv("ZUNA_PUSH_BEHIND_CLOUDFLARE"))
	flags.BoolVar(&cloudflare, "behind-cloudflare", cloudflare, "take a request from Cloudflare's proxy to be from whoever it names in CF-Connecting-IP (env ZUNA_PUSH_BEHIND_CLOUDFLARE)")
	showVersion := flags.Bool("version", false, "print the version and exit")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *showVersion {
		fmt.Fprintln(out, version)
		return nil
	}

	handleKey, err := loadHandleKey(*data)
	if err != nil {
		return fmt.Errorf("the handle key: %w", err)
	}
	var apns *relay.APNs
	if *keyFile != "" {
		p8, err := os.ReadFile(*keyFile)
		if err != nil {
			return fmt.Errorf("reading the APNs key: %w", err)
		}
		if apns, err = relay.NewAPNs(p8, *keyID, *teamID, *topic); err != nil {
			return err
		}
		apnsReady(apns)
		checkKey(ctx, apns, *keyID, *teamID)
	} else {
		slog.Warn("no APNs key: phones can't register, and pushes fail")
	}
	service, err := relay.New(handleKey, apns)
	if err != nil {
		return err
	}
	var proxies []string
	for _, proxy := range strings.Split(*trustedProxies, ",") {
		if proxy = strings.TrimSpace(proxy); proxy != "" {
			proxies = append(proxies, proxy)
		}
	}
	if service.Callers, err = clientip.New(trustProxy, proxies, cloudflare); err != nil {
		return err
	}
	server := &http.Server{Addr: *listen, Handler: service.Handler(), ErrorLog: logs.HTTPErrors(), ReadTimeout: relay.ReadTimeout, WriteTimeout: relay.WriteTimeout}
	errs := make(chan error, 1)
	go func() { errs <- server.ListenAndServe() }()
	slog.Info("zuna-push listening", "address", *listen, "version", version)
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
		// Pushes already on their way to Apple finish first, which its client gives 15 s.
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			slog.Warn("pushes were still being sent when the relay stopped", "error", err)
		}
	}
	return nil
}

// checkKey asks Apple whether it takes the APNs key in each environment, and says
// so before the relay listens, as a key it refuses otherwise only shows as phones
// failing to register. deploy/update.sh shows what it says.
func checkKey(ctx context.Context, apns *relay.APNs, keyID, teamID string) {
	for _, environment := range []string{"production", "sandbox"} {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := apns.CheckKey(ctx, environment)
		cancel()
		var refused *relay.RefusedError
		switch {
		case err == nil:
			slog.Info("Apple takes the APNs key", "environment", environment, "key_id", keyID, "team", teamID)
		case errors.As(err, &refused):
			slog.Error("Apple refuses the APNs key, so phones can't register: check its Key ID, team and environments", "environment", environment, "key_id", keyID, "team", teamID, "error", err)
		default:
			slog.Warn("couldn't ask Apple about the APNs key", "environment", environment, "error", err)
		}
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
