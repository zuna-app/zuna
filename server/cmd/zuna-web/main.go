// Command zuna-web serves Zuna's web app on an address of its own: the app's
// files with strict security headers, and the link previews a page can't fetch
// for itself. It's never part of a chat server, so a chat server can't change
// the code that holds people's keys (docs/WEB.md).
package main

import (
	"context"
	"crypto/tls"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
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

	"zuna/server/internal/clientip"
	"zuna/server/internal/webhost"
)

var version = "dev"

// Where a server with a domain listens, for HTTPS and for the certificate authority's
// challenges and the redirect to HTTPS. Tests move them.
var httpsAddress, httpAddress = ":443", ":80"

// The built app, copied here by scripts/build-web.mjs. A plain checkout has only
// .gitkeep, and the program then needs --root.
//
//go:embed all:site
var site embed.FS

type config struct {
	listen         string
	domain         string
	dataDir        string
	tlsCert        string
	tlsKey         string
	trustProxy     bool
	trustedProxies string
	cloudflare     bool
	previews       string
	server         string
	servers        string
	mediaServers   string
	root           string
	dev            bool
}

// splitList reads a comma-separated list.
func splitList(value string) []string {
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
	flags := flag.NewFlagSet("zuna-web", flag.ContinueOnError)
	trustProxy, _ := strconv.ParseBool(getenv("ZUNA_WEB_TRUST_PROXY"))
	cloudflare, _ := strconv.ParseBool(getenv("ZUNA_WEB_BEHIND_CLOUDFLARE"))
	flags.StringVar(&cfg.listen, "listen", getenv("ZUNA_WEB_LISTEN"), "address to listen on, such as :8080 (env ZUNA_WEB_LISTEN)")
	flags.StringVar(&cfg.domain, "domain", getenv("ZUNA_WEB_DOMAIN"), "public domain; turns on automatic HTTPS on ports 80 and 443 (env ZUNA_WEB_DOMAIN)")
	flags.StringVar(&cfg.dataDir, "data", envOr("ZUNA_WEB_DATA", "./zuna-web-data"), "folder for automatic HTTPS certificates (env ZUNA_WEB_DATA)")
	flags.StringVar(&cfg.tlsCert, "tls-cert", getenv("ZUNA_WEB_TLS_CERT"), "TLS certificate file, if you manage certificates yourself (env ZUNA_WEB_TLS_CERT)")
	flags.StringVar(&cfg.tlsKey, "tls-key", getenv("ZUNA_WEB_TLS_KEY"), "TLS key file (env ZUNA_WEB_TLS_KEY)")
	flags.BoolVar(&cfg.trustProxy, "trust-proxy", trustProxy, "trust X-Forwarded-For from a reverse proxy on this machine or a private network, for rate limiting (env ZUNA_WEB_TRUST_PROXY)")
	flags.StringVar(&cfg.trustedProxies, "trusted-proxies", getenv("ZUNA_WEB_TRUSTED_PROXIES"), "comma-separated addresses or CIDR ranges of reverse proxies to trust, instead of those networks (env ZUNA_WEB_TRUSTED_PROXIES)")
	flags.BoolVar(&cfg.cloudflare, "behind-cloudflare", cloudflare, "take a request from Cloudflare's proxy to be from whoever it names in CF-Connecting-IP, for rate limiting (env ZUNA_WEB_BEHIND_CLOUDFLARE)")
	flags.StringVar(&cfg.previews, "previews", envOr("ZUNA_WEB_PREVIEWS", "on"), `"on" to fetch pages for link previews, "off" not to (env ZUNA_WEB_PREVIEWS)`)
	flags.StringVar(&cfg.server, "server", getenv("ZUNA_WEB_SERVER"), "a server address to fill in on the sign-in form (env ZUNA_WEB_SERVER)")
	flags.StringVar(&cfg.servers, "servers", getenv("ZUNA_WEB_SERVERS"), "comma-separated servers that are the only ones the app may connect to; empty for any (env ZUNA_WEB_SERVERS)")
	flags.StringVar(&cfg.mediaServers, "media-servers", getenv("ZUNA_WEB_MEDIA_SERVERS"), "with --servers: the LiveKit servers those servers' voice channels use, if apps reach them directly (env ZUNA_WEB_MEDIA_SERVERS)")
	flags.StringVar(&cfg.root, "root", getenv("ZUNA_WEB_ROOT"), "serve the app from this folder (apps/web/dist) instead of the copy built in (env ZUNA_WEB_ROOT)")
	flags.BoolVar(&cfg.dev, "dev", false, "development only: previews may reach this machine, and the app's files aren't needed")
	flags.BoolVar(&showVersion, "version", false, "print the version and exit")
	if err := flags.Parse(args); err != nil {
		return config{}, false, err
	}
	if showVersion {
		return config{}, true, nil
	}
	if cfg.listen == "" && cfg.domain == "" {
		cfg.listen = ":8080"
	}
	return cfg, false, nil
}

// appFiles is the folder given with --root, or the copy built into the program.
func appFiles(cfg config) (fs.FS, error) {
	var files fs.FS
	if cfg.root != "" {
		files = os.DirFS(cfg.root)
	} else {
		sub, err := fs.Sub(site, "site")
		if err != nil {
			return nil, err
		}
		files = sub
	}
	if _, err := fs.Stat(files, "index.html"); err != nil {
		if cfg.dev {
			return nil, nil
		}
		if cfg.root != "" {
			return nil, fmt.Errorf("%s has no index.html: build the app with npm run build -w @zuna/web", cfg.root)
		}
		return nil, errors.New("this build has no web app in it: build it with npm run build:web, or pass --root apps/web/dist")
	}
	return files, nil
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
		fmt.Println("zuna-web", version)
		return
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, cfg, os.Stdout); err != nil {
		slog.Error("zuna-web stopped", "error", err)
		os.Exit(1)
	}
}

// run serves until ctx ends, saying where on out.
func run(ctx context.Context, cfg config, out io.Writer) error {
	if cfg.previews != "on" && cfg.previews != "off" {
		return fmt.Errorf(`--previews is "on" or "off", not %q`, cfg.previews)
	}
	files, err := appFiles(cfg)
	if err != nil {
		return err
	}
	resolver, err := clientip.New(cfg.trustProxy, splitList(cfg.trustedProxies), cfg.cloudflare)
	if err != nil {
		return err
	}
	servers := splitList(cfg.servers)
	handler, err := webhost.New(webhost.Config{
		Files:        files,
		Previews:     cfg.previews == "on",
		Server:       strings.TrimRight(cfg.server, "/"),
		Servers:      servers,
		MediaServers: splitList(cfg.mediaServers),
		AllowLocal:   cfg.dev,
		ClientIP:     resolver,
	})
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      2 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}

	errs := make(chan error, 2)
	listenAddress := ""
	scheme := "http"
	switch {
	case cfg.domain != "":
		listenAddress = httpsAddress
		scheme = "https"
		if err := os.MkdirAll(cfg.dataDir, 0o750); err != nil {
			return fmt.Errorf("creating data folder: %w", err)
		}
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
		}
		go func() { errs <- redirect.ListenAndServe() }()
		go func() { errs <- httpServer.ListenAndServeTLS("", "") }()
		go func() {
			<-ctx.Done()
			redirect.Close()
		}()
	case cfg.tlsCert != "":
		listenAddress = cfg.listen
		scheme = "https"
		httpServer.Addr = cfg.listen
		httpServer.TLSConfig = &tls.Config{MinVersion: tls.VersionTLS12}
		go func() { errs <- httpServer.ListenAndServeTLS(cfg.tlsCert, cfg.tlsKey) }()
	default:
		listenAddress = cfg.listen
		httpServer.Addr = cfg.listen
		go func() { errs <- httpServer.ListenAndServe() }()
	}

	printBanner(out, cfg, files != nil, scheme, listenAddress, servers)

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

func printBanner(out io.Writer, cfg config, hasApp bool, scheme, listenAddress string, servers []string) {
	fmt.Fprintf(out, "\n  Zuna web %s\n", version)
	address := cfg.domain
	if address == "" {
		host, port, _ := net.SplitHostPort(listenAddress)
		if host == "" || host == "0.0.0.0" || host == "::" {
			host = "localhost"
		}
		address = net.JoinHostPort(host, port)
	}
	if hasApp {
		fmt.Fprintf(out, "  Listening on %s, open %s://%s\n", listenAddress, scheme, address)
	} else {
		fmt.Fprintf(out, "  Listening on %s, without the app's files (development)\n", listenAddress)
	}
	if scheme == "http" && !cfg.dev {
		fmt.Fprintf(out, "  Browsers only run Zuna over HTTPS, apart from localhost. Use --domain, --tls-cert, or a reverse proxy.\n")
	}
	fmt.Fprintf(out, "  Link previews: %s\n", cfg.previews)
	if len(servers) > 0 {
		fmt.Fprintf(out, "  Only these servers: %s\n", strings.Join(servers, ", "))
	}
	fmt.Fprintln(out)
}
