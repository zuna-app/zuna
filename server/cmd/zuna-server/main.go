// Command zuna-server runs a self-hosted Zuna server: one binary, one data folder.
package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"zuna/server/internal/api"
	"zuna/server/internal/clientip"
	"zuna/server/internal/store"
)

var version = "dev"

// defaultPushRelay is the project's push relay, which the published Zuna app
// registers with (docs/PUSH_RELAY.md). It only ever sees sealed pushes.
const defaultPushRelay = "https://relay.zuna.chat"

type config struct {
	dataDir         string
	databaseURL     string
	domain          string
	listen          string
	publicURL       string
	tlsCert         string
	tlsKey          string
	trustProxy      bool
	trustedProxies  string
	cloudflare      bool
	downloadURL     string
	authBurst       int
	userQuotaMB     int
	pushRelays      string
	liveKitURL      string
	liveKitInternal string
	liveKitKey      string
	liveKitSecret   string
	liveKitKeys     string
	// The address given instead of a domain, for which the server makes its own
	// certificate, and that certificate's pin, which the server's links carry.
	ip  net.IP
	pin string
}

// splitList reads a comma-separated list of addresses. "off" is none.
func splitList(value string) []string {
	if strings.TrimSpace(value) == "off" {
		return nil
	}
	var items []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimRight(strings.TrimSpace(item), "/"); item != "" {
			items = append(items, item)
		}
	}
	return items
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func parseFlags() config {
	var cfg config
	trustProxy, _ := strconv.ParseBool(os.Getenv("ZUNA_TRUST_PROXY"))
	cloudflare, _ := strconv.ParseBool(os.Getenv("ZUNA_BEHIND_CLOUDFLARE"))
	flag.StringVar(&cfg.dataDir, "data", envOr("ZUNA_DATA", "./zuna-data"), "folder for the database and uploaded files (env ZUNA_DATA)")
	flag.StringVar(&cfg.databaseURL, "database-url", os.Getenv("ZUNA_DATABASE_URL"), "PostgreSQL database to use instead of the one in the data folder, such as postgres://zuna:password@localhost/zuna (env ZUNA_DATABASE_URL)")
	flag.StringVar(&cfg.domain, "domain", os.Getenv("ZUNA_DOMAIN"), "public domain, which turns on automatic HTTPS on ports 80 and 443, or this machine's IP address, for which the server makes its own certificate (env ZUNA_DOMAIN)")
	flag.StringVar(&cfg.listen, "listen", os.Getenv("ZUNA_LISTEN"), "address to listen on, such as :9660 (env ZUNA_LISTEN)")
	flag.StringVar(&cfg.publicURL, "public-url", os.Getenv("ZUNA_PUBLIC_URL"), "address members use to reach this server, needed behind a reverse proxy (env ZUNA_PUBLIC_URL)")
	flag.StringVar(&cfg.tlsCert, "tls-cert", os.Getenv("ZUNA_TLS_CERT"), "TLS certificate file, if you manage certificates yourself (env ZUNA_TLS_CERT)")
	flag.StringVar(&cfg.tlsKey, "tls-key", os.Getenv("ZUNA_TLS_KEY"), "TLS key file (env ZUNA_TLS_KEY)")
	flag.BoolVar(&cfg.trustProxy, "trust-proxy", trustProxy, "trust X-Forwarded-For from a reverse proxy on this machine or a private network, for rate limiting (env ZUNA_TRUST_PROXY)")
	flag.StringVar(&cfg.trustedProxies, "trusted-proxies", os.Getenv("ZUNA_TRUSTED_PROXIES"), "comma-separated addresses or CIDR ranges of reverse proxies to trust, instead of those networks (env ZUNA_TRUSTED_PROXIES)")
	flag.BoolVar(&cfg.cloudflare, "behind-cloudflare", cloudflare, "take a request from Cloudflare's proxy to be from whoever it names in CF-Connecting-IP, for rate limiting (env ZUNA_BEHIND_CLOUDFLARE)")
	flag.StringVar(&cfg.downloadURL, "download-url", envOr("ZUNA_DOWNLOAD_URL", ""), "where invite pages link for downloading the app, as well as the official releases (env ZUNA_DOWNLOAD_URL)")
	flag.IntVar(&cfg.authBurst, "auth-burst", 0, "sign-in attempts allowed at once per address (default 20)")
	quota, _ := strconv.Atoi(os.Getenv("ZUNA_USER_QUOTA_MB"))
	flag.IntVar(&cfg.userQuotaMB, "user-quota-mb", quota, "how many MB of files each person may keep, or -1 for no limit (default 10240) (env ZUNA_USER_QUOTA_MB)")
	flag.StringVar(&cfg.pushRelays, "push-relays", envOr("ZUNA_PUSH_RELAYS", defaultPushRelay), `comma-separated push relays that may wake phones for new messages, or "off" (env ZUNA_PUSH_RELAYS)`)
	flag.StringVar(&cfg.liveKitURL, "livekit-url", os.Getenv("ZUNA_LIVEKIT_URL"), "LiveKit server for voice channels, as apps reach it, such as wss://voice.example.com (env ZUNA_LIVEKIT_URL)")
	flag.StringVar(&cfg.liveKitInternal, "livekit-internal-url", os.Getenv("ZUNA_LIVEKIT_INTERNAL_URL"), "how this server reaches LiveKit, if not by that address (env ZUNA_LIVEKIT_INTERNAL_URL)")
	flag.StringVar(&cfg.liveKitKey, "livekit-key", os.Getenv("ZUNA_LIVEKIT_KEY"), "LiveKit API key (env ZUNA_LIVEKIT_KEY)")
	flag.StringVar(&cfg.liveKitSecret, "livekit-secret", os.Getenv("ZUNA_LIVEKIT_SECRET"), "LiveKit API secret (env ZUNA_LIVEKIT_SECRET)")
	flag.StringVar(&cfg.liveKitKeys, "livekit-keys", os.Getenv("ZUNA_LIVEKIT_KEYS"), "LiveKit's key file, to take the key and secret from instead, which is made with new ones if it isn't there (env ZUNA_LIVEKIT_KEYS)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("zuna-server", version)
		os.Exit(0)
	}
	cfg.ip = net.ParseIP(strings.Trim(cfg.domain, "[]"))
	if cfg.listen == "" {
		switch {
		case cfg.ip != nil:
			cfg.listen = ":443"
		case cfg.domain == "":
			cfg.listen = ":9660"
		}
	}
	if cfg.publicURL == "" {
		switch {
		case cfg.ip != nil:
			cfg.publicURL = "https://" + urlHost(cfg.ip)
			if port := portSuffix(cfg.listen); port != ":443" {
				cfg.publicURL += port
			}
		case cfg.domain != "":
			cfg.publicURL = "https://" + cfg.domain
		case cfg.tlsCert != "":
			cfg.publicURL = "https://localhost" + portSuffix(cfg.listen)
		default:
			cfg.publicURL = "http://localhost" + portSuffix(cfg.listen)
		}
	}
	cfg.publicURL = strings.TrimRight(cfg.publicURL, "/")
	return cfg
}

func portSuffix(listen string) string {
	_, port, err := net.SplitHostPort(listen)
	if err != nil || port == "" {
		return ""
	}
	return ":" + port
}

func main() {
	cfg := parseFlags()
	if err := run(cfg); err != nil {
		slog.Error("zuna-server stopped", "error", err)
		os.Exit(1)
	}
}

func run(cfg config) error {
	if err := os.MkdirAll(cfg.dataDir, 0o750); err != nil {
		return fmt.Errorf("creating data folder: %w", err)
	}
	if cfg.liveKitKeys != "" {
		if cfg.liveKitKey != "" || cfg.liveKitSecret != "" {
			return errors.New("LiveKit's key and secret come from --livekit-keys, or from --livekit-key and --livekit-secret, not both")
		}
		key, secret, err := liveKitKeys(cfg.liveKitKeys)
		if err != nil {
			return err
		}
		cfg.liveKitKey, cfg.liveKitSecret = key, secret
	}
	var db *store.DB
	var err error
	if cfg.databaseURL != "" {
		db, err = store.OpenPostgres(cfg.databaseURL)
	} else {
		db, err = store.Open(filepath.Join(cfg.dataDir, "zuna.db"))
	}
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer db.Close()

	proxies := splitList(cfg.trustedProxies)
	if _, err := clientip.New(cfg.trustProxy, proxies, cfg.cloudflare); err != nil {
		return err
	}
	// For tests only: how long someone shows as online after they stop using Zuna, instead of 5 s.
	linger, _ := time.ParseDuration(os.Getenv("ZUNA_TEST_PRESENCE_LINGER"))
	srv := api.New(api.Config{
		DataDir:          cfg.dataDir,
		PublicURL:        cfg.publicURL,
		Version:          version,
		TrustProxy:       cfg.trustProxy,
		TrustedProxies:   proxies,
		BehindCloudflare: cfg.cloudflare,
		DownloadURL:      cfg.downloadURL,
		AuthBurst:        cfg.authBurst,
		UserQuotaMB:      cfg.userQuotaMB,
		PushRelays:       splitList(cfg.pushRelays),

		LiveKitURL:         cfg.liveKitURL,
		LiveKitInternalURL: cfg.liveKitInternal,
		LiveKitKey:         cfg.liveKitKey,
		LiveKitSecret:      cfg.liveKitSecret,
		PresenceLinger:     linger,
	}, db)
	// For tests only: a stand-in for 7TV, so emote tests don't depend on the internet.
	if base := os.Getenv("ZUNA_7TV_API"); base != "" {
		srv.Emotes().APIBase = base
	}
	if base := os.Getenv("ZUNA_7TV_CDN"); base != "" {
		srv.Emotes().CDNBase = base
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	srv.RunBackground(ctx)

	httpServer := &http.Server{
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// So a slow upload or a client that stops reading can't hold a connection
		// open for ever. Sockets aren't bound by them once they've connected, and
		// large bodies get longer.
		ReadTimeout:  api.ReadTimeout,
		WriteTimeout: api.WriteTimeout,
		IdleTimeout:  2 * time.Minute,
	}
	httpServer.RegisterOnShutdown(srv.CloseSockets)

	errs := make(chan error, 2)
	listenAddress := ""
	switch {
	case cfg.ip != nil:
		certificate, pin, err := ownCertificate(filepath.Join(cfg.dataDir, certificateKeyFile), cfg.ip)
		if err != nil {
			return err
		}
		cfg.pin = pin
		listenAddress = cfg.listen
		httpServer.Addr = cfg.listen
		httpServer.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: certificate}
		go func() { errs <- httpServer.ListenAndServeTLS("", "") }()
	case cfg.domain != "":
		listenAddress = ":443"
		manager := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(cfg.domain),
			Cache:      autocert.DirCache(filepath.Join(cfg.dataDir, "certs")),
		}
		httpServer.Addr = ":443"
		httpServer.TLSConfig = manager.TLSConfig()
		redirect := &http.Server{
			Addr:              ":80",
			Handler:           manager.HTTPHandler(nil),
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       time.Minute,
		}
		go func() { errs <- redirect.ListenAndServe() }()
		go func() { errs <- httpServer.ListenAndServeTLS("", "") }()
		go func() {
			<-ctx.Done()
			redirect.Close()
		}()
	case cfg.tlsCert != "":
		listenAddress = cfg.listen
		httpServer.Addr = cfg.listen
		httpServer.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		go func() { errs <- httpServer.ListenAndServeTLS(cfg.tlsCert, cfg.tlsKey) }()
	default:
		listenAddress = cfg.listen
		httpServer.Addr = cfg.listen
		go func() { errs <- httpServer.ListenAndServe() }()
	}

	printBanner(ctx, srv, cfg, listenAddress)

	select {
	case err := <-errs:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := httpServer.Shutdown(shutdownCtx)
		// Sockets and the background loops outlast Shutdown, and the database closes after this.
		srv.Wait(shutdownCtx)
		return err
	}
}

func printBanner(ctx context.Context, srv *api.Server, cfg config, listenAddress string) {
	fmt.Printf("\n  Zuna server %s\n", version)
	fmt.Printf("  Listening on %s, reachable at %s\n", listenAddress, cfg.publicURL)
	fmt.Printf("  Data folder: %s\n", cfg.dataDir)
	if relays := splitList(cfg.pushRelays); len(relays) > 0 {
		fmt.Printf("  Phone notifications go through: %s\n", strings.Join(relays, ", "))
		fmt.Printf("  They only see sealed pushes. To change this, set --push-relays or ZUNA_PUSH_RELAYS (\"off\" for none).\n")
	}
	// The apps learn the pin only from links, as browsers don't send what's after # to the server.
	fragment := ""
	if cfg.pin != "" {
		fragment = "#pin=" + cfg.pin
		fmt.Printf("\n  This server makes its own certificate, which the apps check against the pin\n")
		fmt.Printf("  in its links, so share them whole. The web app can't check it, so it can't connect.\n")
		fmt.Printf("  Keep %s from the data folder with your backups: a new one\n", certificateKeyFile)
		fmt.Printf("  would need a new link for every app.\n")
		fmt.Printf("  To sign in on another device, enter: %s%s\n", cfg.publicURL, fragment)
	}
	code, err := srv.EnsureSetupInvite(ctx)
	if err != nil {
		slog.Error("creating the setup link", "error", err)
		return
	}
	if code != "" {
		fmt.Printf("\n  Finish setup: paste this one-time link into the Zuna app.\n")
		fmt.Printf("  It creates your owner account.\n\n")
		fmt.Printf("    %s/invite/%s%s\n\n", cfg.publicURL, code, fragment)
	} else {
		fmt.Println()
	}
}
