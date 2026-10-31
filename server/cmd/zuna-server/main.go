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
	"zuna/server/internal/store"
)

var version = "dev"

type config struct {
	dataDir     string
	domain      string
	listen      string
	publicURL   string
	tlsCert     string
	tlsKey      string
	trustProxy  bool
	downloadURL string
	authBurst   int
	pushRelays  string
}

// splitList reads a comma-separated list of addresses.
func splitList(value string) []string {
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
	flag.StringVar(&cfg.dataDir, "data", envOr("ZUNA_DATA", "./zuna-data"), "folder for the database and uploaded files (env ZUNA_DATA)")
	flag.StringVar(&cfg.domain, "domain", os.Getenv("ZUNA_DOMAIN"), "public domain; turns on automatic HTTPS on ports 80 and 443 (env ZUNA_DOMAIN)")
	flag.StringVar(&cfg.listen, "listen", os.Getenv("ZUNA_LISTEN"), "address to listen on, such as :8080 (env ZUNA_LISTEN)")
	flag.StringVar(&cfg.publicURL, "public-url", os.Getenv("ZUNA_PUBLIC_URL"), "address members use to reach this server, needed behind a reverse proxy (env ZUNA_PUBLIC_URL)")
	flag.StringVar(&cfg.tlsCert, "tls-cert", os.Getenv("ZUNA_TLS_CERT"), "TLS certificate file, if you manage certificates yourself (env ZUNA_TLS_CERT)")
	flag.StringVar(&cfg.tlsKey, "tls-key", os.Getenv("ZUNA_TLS_KEY"), "TLS key file (env ZUNA_TLS_KEY)")
	flag.BoolVar(&cfg.trustProxy, "trust-proxy", trustProxy, "trust X-Forwarded-For from a reverse proxy, for rate limiting (env ZUNA_TRUST_PROXY)")
	flag.StringVar(&cfg.downloadURL, "download-url", envOr("ZUNA_DOWNLOAD_URL", ""), "where invite pages link for downloading the app (env ZUNA_DOWNLOAD_URL)")
	flag.IntVar(&cfg.authBurst, "auth-burst", 0, "sign-in attempts allowed at once per address (default 20)")
	flag.StringVar(&cfg.pushRelays, "push-relays", os.Getenv("ZUNA_PUSH_RELAYS"), "comma-separated push relays that may wake phones for new messages (env ZUNA_PUSH_RELAYS)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("zuna-server", version)
		os.Exit(0)
	}
	if cfg.listen == "" && cfg.domain == "" {
		cfg.listen = ":8080"
	}
	if cfg.publicURL == "" {
		switch {
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
	db, err := store.Open(filepath.Join(cfg.dataDir, "zuna.db"))
	if err != nil {
		return fmt.Errorf("opening database: %w", err)
	}
	defer db.Close()

	srv := api.New(api.Config{
		DataDir:     cfg.dataDir,
		PublicURL:   cfg.publicURL,
		Version:     version,
		TrustProxy:  cfg.trustProxy,
		DownloadURL: cfg.downloadURL,
		AuthBurst:   cfg.authBurst,
		PushRelays:  splitList(cfg.pushRelays),
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
		IdleTimeout:       2 * time.Minute,
	}

	errs := make(chan error, 2)
	listenAddress := ""
	switch {
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
		return httpServer.Shutdown(shutdownCtx)
	}
}

func printBanner(ctx context.Context, srv *api.Server, cfg config, listenAddress string) {
	fmt.Printf("\n  Zuna server %s\n", version)
	fmt.Printf("  Listening on %s, reachable at %s\n", listenAddress, cfg.publicURL)
	fmt.Printf("  Data folder: %s\n", cfg.dataDir)
	code, err := srv.EnsureSetupInvite(ctx)
	if err != nil {
		slog.Error("creating the setup link", "error", err)
		return
	}
	if code != "" {
		fmt.Printf("\n  Finish setup: paste this one-time link into the Zuna app.\n")
		fmt.Printf("  It creates your owner account.\n\n")
		fmt.Printf("    %s/invite/%s\n\n", cfg.publicURL, code)
	} else {
		fmt.Println()
	}
}
