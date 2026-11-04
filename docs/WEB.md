# The web app

Zuna in a browser: the desktop app's interface and everything it does, except system notifications. You host it yourself with `zuna-web`, a small program of its own. It's never part of a chat server.

## Before you run it

A web app's code comes from its host on every visit. Whoever controls the host can send code that reads the keys and messages of everyone who opens it. That's the difference from the installed apps, and the reason for the rules below. `SECURITY.md` has the rest.

- **Host it yourself, or use one run by someone you'd trust with your messages.** The web app is exactly as trustworthy as the machine serving it.
- **Give it a domain of its own,** such as `web.chat.example.com`, and never the chat server's address. Browsers share storage within an address, so a chat server's pages on the same one could reach the web app's data. Separate hosts also mean a chat server that's broken into can't change the code that holds your keys.
- **Only over HTTPS.** Browsers only give the app what it needs on a secure page. Plain `http://localhost` works too, for trying it out.
- **Your local data is less protected than on the desktop.** Browsers have no keychain a page can use, so anyone who can copy your browser's profile can read Zuna's local data. On a computer others use, sign out when you're done, or use the desktop app.

## What's different from the desktop

| | Desktop | Web |
|---|---|---|
| New messages | System notifications, sound, dock or taskbar badge | The browser's notifications, which it asks to allow at your first click, and sound. The tab's title counts them: `(3) Zuna` |
| Your phone | While you use the app, notified 30 seconds later about what you didn't read there | The same, while the tab is in front |
| Invite links | `zuna://` links open the app | Paste the link, or open `https://web.example/#join=<invite link>` |
| Updates | Signed builds update themselves | A reload, offered when the host has a newer version |
| Running in the background | Stays in the tray | Runs while its tab is open |
| Tabs and windows | One window | One tab at a time. Another tab offers "Use here" |
| Window size | At least 860 × 540 | The same. A smaller window shows a notice |
| Device key | In the operating system's keychain | In the browser's storage, with a warning in Settings |

Current Chrome, Edge, Firefox and Safari can all run it. Two things to know:

- **Safari clears a site's data after 7 days without a visit,** and keeps nothing for private windows, where Zuna says it can't run. If your data is cleared, sign in again and your history comes back from your servers.
- **Voice and video messages sent from Firefox don't play on iPhones yet.** Firefox records them as WebM, which iPhones can't play. Everything else in the project's browser checks works in Firefox.

## Running it

`zuna-web` is one file with the web app inside it. Get it from a release, or build it with `npm run build:web`, which puts it in `dist/web` for each platform.

### With deploy/update.sh

On a Linux machine with systemd, the script that installs and updates the chat server can build and run the web app too, behind your reverse proxy:

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com --web web.chat.example.com
```

[LINUX.md](LINUX.md) covers it, and the proxy settings for the web app's domain.

### With its own HTTPS

On a machine where ports 80 and 443 are free, with the domain pointing at it:

```bash
zuna-web --domain web.chat.example.com --server https://chat.example.com
```

Certificates are obtained and renewed automatically and kept in `--data` (default `./zuna-web-data`).

With Docker, from `deploy/`, after `npm run build:web`:

```bash
ZUNA_WEB_DOMAIN=web.chat.example.com ZUNA_WEB_SERVER=https://chat.example.com docker compose -f docker-compose.web.yml up -d
```

### Behind your reverse proxy

If a chat server or another site already uses ports 80 and 443, run `zuna-web` on plain HTTP on this machine, and let your proxy add HTTPS:

```bash
zuna-web --listen 127.0.0.1:8081 --trust-proxy --server https://chat.example.com
```

`deploy/docker-compose.web-proxy.yml` and `deploy/zuna-web.service` (systemd) do the same. For Caddy:

```
web.chat.example.com {
	reverse_proxy 127.0.0.1:8081
}
```

For nginx, inside a `server` block for the web app's domain with your certificates:

```
location / {
    proxy_pass http://127.0.0.1:8081;
    proxy_set_header X-Forwarded-For $remote_addr;
}
```

Don't add headers of your own on top: `zuna-web` sends the content security policy and the rest, and a proxy that changes them can weaken them.

### Without zuna-web

The app is also plain files, in `apps/web/dist` after `npm run build -w @zuna/web`. Any web server can serve them, but then there are no link previews, and the security headers are up to you: copy them from `server/internal/webhost/webhost.go`, or the page loses its content security policy.

## Settings

Each setting is a flag or an environment variable.

| Flag | Variable | What it does |
|---|---|---|
| `--domain` | `ZUNA_WEB_DOMAIN` | Turns on automatic HTTPS on ports 80 and 443 |
| `--listen` | `ZUNA_WEB_LISTEN` | The address to listen on, such as `127.0.0.1:8081`. Default `:8080` |
| `--tls-cert`, `--tls-key` | `ZUNA_WEB_TLS_CERT`, `ZUNA_WEB_TLS_KEY` | Your own certificate |
| `--data` | `ZUNA_WEB_DATA` | Where automatic HTTPS keeps its certificates |
| `--trust-proxy` | `ZUNA_WEB_TRUST_PROXY` | Takes callers' addresses from a reverse proxy on this machine or a private network, for rate limits |
| `--trusted-proxies` | `ZUNA_WEB_TRUSTED_PROXIES` | Exactly which proxies to trust, as addresses or CIDR ranges |
| `--server` | `ZUNA_WEB_SERVER` | A server address filled in on the sign-in form |
| `--servers` | `ZUNA_WEB_SERVERS` | If set, the only servers the app may connect to, separated by commas. The browser enforces it |
| `--previews` | `ZUNA_WEB_PREVIEWS` | `off` stops `zuna-web` fetching pages for link previews |
| `--root` | `ZUNA_WEB_ROOT` | Serves the app from a folder instead of the copy inside the program |

## Link previews

A page can't read other sites, so `zuna-web` fetches pages for the previews people make while writing. It follows the desktop's rules: only HTTPS on the usual port, only public addresses, every redirect checked, at most 5 MiB, no cookies. The address a name leads to is checked as the connection is made. The app's own pages are the only ones a browser lets ask, but a script can send anything, so this makes the host a small public fetcher, with its address taking the blame. Each address is limited, by the moment and by the day, and so is the host overall.

This means the host sees which links people preview. Websites see the host's address, not the person's. The chat server still never sees the links. To turn previews off, set `--previews off`.

## Checking a running copy

Each release lists the SHA-256 of every file the web app serves, in `zuna-web-files.sha256`. To check that a copy serves exactly that release:

```bash
node scripts/check-web.mjs https://web.chat.example.com zuna-web-files.sha256
```

It fetches every file and fails if any differs, or if the page loads a file the release doesn't have. It checks what the host serves at that moment, not what it served earlier or will serve to someone else.

## Upgrading

Replace the program, or pull the new image, and restart it. Open tabs notice the new version within 30 minutes, or when they're next focused, and offer a reload. An older version may not understand local data a newer one has already updated, so upgrade, don't downgrade.
