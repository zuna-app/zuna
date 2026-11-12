// Command zuna-server runs a self-hosted Zuna server: one binary, one data folder.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
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

// Where a server with a domain listens, for HTTPS and for the certificate authority's
// challenges and the redirect to HTTPS. Tests move them.
var httpsAddress, httpAddress = ":443", ":80"

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
	// newLogEra starts the log of keys again from what the database holds, as after
	// restoring a backup, and stops.
	newLogEra bool
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

// parseFlags reads the command line, with getenv giving what's in the environment.
// showVersion says only the version was asked for.
func parseFlags(args []string, getenv func(string) string) (cfg config, showVersion bool, err error) {
	envOr := func(key, fallback string) string {
		if value := getenv(key); value != "" {
			return value
		}
		return fallback
	}
	flags := flag.NewFlagSet("zuna-server", flag.ContinueOnError)
	trustProxy, _ := strconv.ParseBool(getenv("ZUNA_TRUST_PROXY"))
	cloudflare, _ := strconv.ParseBool(getenv("ZUNA_BEHIND_CLOUDFLARE"))
	flags.StringVar(&cfg.dataDir, "data", envOr("ZUNA_DATA", "./zuna-data"), "folder for the database and uploaded files (env ZUNA_DATA)")
	flags.StringVar(&cfg.databaseURL, "database-url", getenv("ZUNA_DATABASE_URL"), "PostgreSQL database to use instead of the one in the data folder, such as postgres://zuna:password@localhost/zuna (env ZUNA_DATABASE_URL)")
	flags.StringVar(&cfg.domain, "domain", getenv("ZUNA_DOMAIN"), "public domain, which turns on automatic HTTPS on ports 80 and 443, or this machine's IP address, for which the server makes its own certificate (env ZUNA_DOMAIN)")
	flags.StringVar(&cfg.listen, "listen", getenv("ZUNA_LISTEN"), "address to listen on, such as :9660 (env ZUNA_LISTEN)")
	flags.StringVar(&cfg.publicURL, "public-url", getenv("ZUNA_PUBLIC_URL"), "address members use to reach this server, needed behind a reverse proxy (env ZUNA_PUBLIC_URL)")
	flags.StringVar(&cfg.tlsCert, "tls-cert", getenv("ZUNA_TLS_CERT"), "TLS certificate file, if you manage certificates yourself (env ZUNA_TLS_CERT)")
	flags.StringVar(&cfg.tlsKey, "tls-key", getenv("ZUNA_TLS_KEY"), "TLS key file (env ZUNA_TLS_KEY)")
	flags.BoolVar(&cfg.trustProxy, "trust-proxy", trustProxy, "trust X-Forwarded-For from a reverse proxy on this machine or a private network, for rate limiting (env ZUNA_TRUST_PROXY)")
	flags.StringVar(&cfg.trustedProxies, "trusted-proxies", getenv("ZUNA_TRUSTED_PROXIES"), "comma-separated addresses or CIDR ranges of reverse proxies to trust, instead of those networks (env ZUNA_TRUSTED_PROXIES)")
	flags.BoolVar(&cfg.cloudflare, "behind-cloudflare", cloudflare, "take a request from Cloudflare's proxy to be from whoever it names in CF-Connecting-IP, for rate limiting (env ZUNA_BEHIND_CLOUDFLARE)")
	flags.StringVar(&cfg.downloadURL, "download-url", envOr("ZUNA_DOWNLOAD_URL", ""), "where invite pages link for downloading the app, as well as the official releases (env ZUNA_DOWNLOAD_URL)")
	flags.IntVar(&cfg.authBurst, "auth-burst", 0, "sign-in attempts allowed at once per address (default 20)")
	quota, _ := strconv.Atoi(getenv("ZUNA_USER_QUOTA_MB"))
	flags.IntVar(&cfg.userQuotaMB, "user-quota-mb", quota, "how many MB of files each person may keep, or -1 for no limit (default 10240) (env ZUNA_USER_QUOTA_MB)")
	flags.StringVar(&cfg.pushRelays, "push-relays", envOr("ZUNA_PUSH_RELAYS", defaultPushRelay), `comma-separated push relays that may wake phones for new messages, or "off" (env ZUNA_PUSH_RELAYS)`)
	flags.StringVar(&cfg.liveKitURL, "livekit-url", getenv("ZUNA_LIVEKIT_URL"), "LiveKit server for voice channels, as apps reach it, such as wss://voice.example.com (env ZUNA_LIVEKIT_URL)")
	flags.StringVar(&cfg.liveKitInternal, "livekit-internal-url", getenv("ZUNA_LIVEKIT_INTERNAL_URL"), "how this server reaches LiveKit, if not by that address (env ZUNA_LIVEKIT_INTERNAL_URL)")
	flags.StringVar(&cfg.liveKitKey, "livekit-key", getenv("ZUNA_LIVEKIT_KEY"), "LiveKit API key (env ZUNA_LIVEKIT_KEY)")
	flags.StringVar(&cfg.liveKitSecret, "livekit-secret", getenv("ZUNA_LIVEKIT_SECRET"), "LiveKit API secret (env ZUNA_LIVEKIT_SECRET)")
	flags.StringVar(&cfg.liveKitKeys, "livekit-keys", getenv("ZUNA_LIVEKIT_KEYS"), "LiveKit's key file, to take the key and secret from instead, which is made with new ones if it isn't there (env ZUNA_LIVEKIT_KEYS)")
	flags.BoolVar(&cfg.newLogEra, "new-log-era", false, "start the log of who holds which keys again from what the database holds, as after restoring it from a backup, and exit. Every member's app says so once")
	flags.BoolVar(&showVersion, "version", false, "print the version and exit")
	if err := flags.Parse(args); err != nil {
		return config{}, false, err
	}
	if showVersion {
		return config{}, true, nil
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
	return cfg, false, nil
}

func portSuffix(listen string) string {
	_, port, err := net.SplitHostPort(listen)
	if err != nil || port == "" {
		return ""
	}
	return ":" + port
}

func main() {
	cfg, showVersion, err := parseFlags(os.Args[1:], os.Getenv)
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		os.Exit(2)
	}
	if showVersion {
		fmt.Println("zuna-server", version)
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, os.Stdout); err != nil {
		slog.Error("zuna-server stopped", "error", err)
		os.Exit(1)
	}
}

// run serves until ctx ends, saying where on out.
func run(ctx context.Context, cfg config, out io.Writer) error {
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
	if cfg.newLogEra {
		era, err := db.StartLogEra(context.Background())
		if err != nil {
			return fmt.Errorf("starting the log of keys again: %w", err)
		}
		fmt.Fprintf(out, "The log of keys is in era %d now. Start the server again without --new-log-era.\n", era)
		return nil
	}

	proxies := splitList(cfg.trustedProxies)
	if _, err := clientip.New(cfg.trustProxy, proxies, cfg.cloudflare); err != nil {
		return err
	}
	// For tests only: how long someone shows as online after they stop using Zuna, instead of 5 s.
	linger, _ := time.ParseDuration(os.Getenv("ZUNA_TEST_PRESENCE_LINGER"))
	// For tests only: how many times over someone is issued a period's tokens, for a test
	// that signs one person in on a new device again and again, each of which fetches its own.
	tokenScale, _ := strconv.Atoi(os.Getenv("ZUNA_TEST_TOKEN_SCALE"))
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
		TokenScale:         tokenScale,
	}, db)
	// For tests only: a stand-in for 7TV, so emote tests don't depend on the internet.
	if base := os.Getenv("ZUNA_7TV_API"); base != "" {
		srv.Emotes().APIBase = base
	}
	if base := os.Getenv("ZUNA_7TV_CDN"); base != "" {
		srv.Emotes().CDNBase = base
	}

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

	// Each address is taken before the banner says so, and one that's busy fails here.
	errs := make(chan error, 2)
	listen := func(address string) (net.Listener, error) {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			return nil, fmt.Errorf("listening on %s: %w", address, err)
		}
		return listener, nil
	}
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
		httpServer.TLSConfig = serverTLS(certificate)
		listener, err := listen(cfg.listen)
		if err != nil {
			return err
		}
		go func() { errs <- httpServer.ServeTLS(listener, "", "") }()
	case cfg.domain != "":
		listenAddress = httpsAddress
		manager := &autocert.Manager{
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(cfg.domain),
			Cache:      autocert.DirCache(filepath.Join(cfg.dataDir, "certs")),
		}
		httpServer.Addr = httpsAddress
		httpServer.TLSConfig = manager.TLSConfig()
		redirect := &http.Server{
			Addr:              httpAddress,
			Handler:           manager.HTTPHandler(nil),
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       time.Minute,
		}
		plain, err := listen(httpAddress)
		if err != nil {
			return err
		}
		listener, err := listen(httpsAddress)
		if err != nil {
			plain.Close()
			return err
		}
		go func() { errs <- redirect.Serve(plain) }()
		go func() { errs <- httpServer.ServeTLS(listener, "", "") }()
		go func() {
			<-ctx.Done()
			redirect.Close()
		}()
	case cfg.tlsCert != "":
		listenAddress = cfg.listen
		httpServer.Addr = cfg.listen
		httpServer.TLSConfig = serverTLS(nil)
		listener, err := listen(cfg.listen)
		if err != nil {
			return err
		}
		go func() { errs <- httpServer.ServeTLS(listener, cfg.tlsCert, cfg.tlsKey) }()
	default:
		listenAddress = cfg.listen
		httpServer.Addr = cfg.listen
		listener, err := listen(cfg.listen)
		if err != nil {
			return err
		}
		go func() { errs <- httpServer.Serve(listener) }()
	}

	printBanner(ctx, out, srv, cfg, listenAddress)

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

func printBanner(ctx context.Context, out io.Writer, srv *api.Server, cfg config, listenAddress string) {
	fmt.Fprintf(out, "\n  Zuna server %s\n", version)
	fmt.Fprintf(out, "  Listening on %s, reachable at %s\n", listenAddress, cfg.publicURL)
	fmt.Fprintf(out, "  Data folder: %s\n", cfg.dataDir)
	if relays := splitList(cfg.pushRelays); len(relays) > 0 {
		fmt.Fprintf(out, "  Phone notifications go through: %s\n", strings.Join(relays, ", "))
		fmt.Fprintf(out, "  They only see sealed pushes. To change this, set --push-relays or ZUNA_PUSH_RELAYS (\"off\" for none).\n")
	}
	// The apps learn the pin only from links, as browsers don't send what's after # to the server.
	fragment := ""
	if cfg.pin != "" {
		fragment = "#pin=" + cfg.pin
		fmt.Fprintf(out, "\n  This server makes its own certificate, which the apps check against the pin\n")
		fmt.Fprintf(out, "  in its links, so share them whole. The web app can't check it, so it can't connect.\n")
		fmt.Fprintf(out, "  Keep %s from the data folder with your backups: a new one\n", certificateKeyFile)
		fmt.Fprintf(out, "  would need a new link for every app.\n")
		fmt.Fprintf(out, "  To sign in on another device, enter: %s%s\n", cfg.publicURL, fragment)
	}
	code, err := srv.EnsureSetupInvite(ctx)
	if err != nil {
		slog.Error("creating the setup link", "error", err)
		return
	}
	if code != "" {
		fmt.Fprintf(out, "\n  Finish setup: paste this one-time link into the Zuna app.\n")
		fmt.Fprintf(out, "  It creates your owner account.\n\n")
		fmt.Fprintf(out, "    %s/invite/%s%s\n\n", cfg.publicURL, code, fragment)
	} else {
		fmt.Fprintln(out)
	}
}
