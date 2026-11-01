# Self-hosting Zuna

A Zuna server is one program and one data folder. There's no separate database, cache or queue to run. The desktop apps and the iPhone and iPad app all connect to the same server.

**You'll need:**
- A machine that stays on. The smallest VPS plans are a reasonable starting point for a friend group, and storage grows with the files people send.
- A domain name pointing at it, such as `chat.example.com`.
- Ports 80 and 443 open, unless you use your own reverse proxy.

Each install is one community with its own members. To host two separate communities, run two installs.

There are three ways to run it:

| | What it does | HTTPS |
|---|---|---|
| [Docker](#option-1-docker) | Builds and runs the server in a container | Automatic, or your own proxy |
| [From source on Linux](#option-2-from-source-on-linux-with-systemd) | Builds the server from git and runs it as a systemd service, without Docker. One command installs and updates it | Your own proxy |
| [The binary](#option-3-run-the-binary-yourself) | A single file you run yourself | Automatic, or your own proxy |

## Option 1: Docker

```bash
git clone https://github.com/SocketByte/zuna-chat.git
```

```bash
cd zuna-chat/deploy
```

```bash
ZUNA_DOMAIN=chat.example.com docker compose up -d
```

Then get your setup link:

```bash
docker compose logs zuna
```

## Option 2: From source on Linux with systemd

```bash
sudo git clone https://github.com/SocketByte/zuna-chat.git /opt/zuna
```

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com
```

This builds the server from the repository, creates a `zuna` system user and starts a hardened systemd service on port 8080, for your own reverse proxy to put HTTPS in front, on this machine or another. It installs Go if needed, and prints your setup link at the end. Running the same script again updates everything, and goes back to the previous build if a new one doesn't start. Data goes in `/var/lib/zuna`. The details are in [LINUX.md](LINUX.md), including proxy settings and running the push relay on the same machine.

## Option 3: Run the binary yourself

Download the file for your platform from the [releases page](https://github.com/SocketByte/zuna-chat/releases), then:

```bash
./zuna-server --domain chat.example.com --data /path/to/data
```

Binding ports 80 and 443 may need extra permissions on your system.

## Finish setup

The server prints a one-time link on its first start:

```
Finish setup: paste this one-time link into the Zuna app.
It creates your owner account.

  https://chat.example.com/invite/a1b2c3...
```

Paste it into the Zuna app, create your account, save your recovery key, and name your server. Then open the server menu and choose **Invite people**.

## Using your own reverse proxy

If Caddy, nginx or Traefik already handles HTTPS, run Zuna on plain HTTP behind it.

- **From source on Linux,** that's how it always runs: on port 8080. See [Your reverse proxy](LINUX.md#your-reverse-proxy), which covers a proxy on another machine.
- **With Docker,** use the proxy's compose file. It listens on `127.0.0.1:8080`, for a proxy on the same machine:

```bash
ZUNA_PUBLIC_URL=https://chat.example.com docker compose -f docker-compose.proxy.yml up -d
```

The proxy must forward WebSockets and allow large uploads.

**Caddy**
```
chat.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx**
```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # your ssl_certificate lines here

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
}
```

Files upload in 1 MiB chunks, so the body size limit doesn't need to match your largest file.

Set `ZUNA_TRUST_PROXY=true` behind a proxy, so that rate limiting sees members' real addresses. It believes `X-Forwarded-For` only from this machine and private networks, reading it from the right so that only what your proxy added counts. For a proxy elsewhere, list it in `ZUNA_TRUSTED_PROXIES`, which replaces those networks. Otherwise all its callers count as one address.

## Configuration

Everything can be set by flag or environment variable.

| Flag | Environment | Default | Purpose |
|---|---|---|---|
| `--domain` | `ZUNA_DOMAIN` | | Turns on automatic HTTPS on ports 80 and 443 |
| `--data` | `ZUNA_DATA` | `./zuna-data` | Where everything is stored |
| `--listen` | `ZUNA_LISTEN` | `:8080` | Address to listen on when not using `--domain` |
| `--public-url` | `ZUNA_PUBLIC_URL` | From the domain | Address people use to reach this server |
| `--tls-cert`, `--tls-key` | `ZUNA_TLS_CERT`, `ZUNA_TLS_KEY` | | Use your own certificate files |
| `--trust-proxy` | `ZUNA_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` from a reverse proxy on this machine or a private network |
| `--trusted-proxies` | `ZUNA_TRUSTED_PROXIES` | | Comma-separated addresses or CIDR ranges of the proxies to trust, instead of those networks |
| `--download-url` | `ZUNA_DOWNLOAD_URL` | | A link for downloading the app, which invite pages show as well as the official releases |
| `--auth-burst` | | `20` | Sign-in attempts allowed at once from one address |
| `--user-quota-mb` | `ZUNA_USER_QUOTA_MB` | `10240` | How many MB of files each person may keep, and as many again of messages, or `-1` for no limit |
| `--push-relays` | `ZUNA_PUSH_RELAYS` | `https://relay.mgalazka.pl` | Comma-separated push relays that may wake phones for new messages, or `off` for none. Phones register with one of them |

The app only connects over HTTPS, except to `localhost`.

Everything else is in the app under **Server settings**: name and picture, invites, members, the 7TV emote set, the upload limit and message retention.

## The web app

To let people use Zuna in a browser, run the web app's own program, `zuna-web`, on a domain of its own, such as `web.chat.example.com`. It isn't part of the server and never should be: [WEB.md](WEB.md) explains why, and how to run it.

## Phone notifications

Phones can't keep a connection open in the background, so the server wakes them through a push relay when a message arrives. The relay sees only that something arrived for some phone: the message stays encrypted on the server, and the phone fetches and decrypts it itself. [PUSH_RELAY.md](PUSH_RELAY.md) explains how it works and how to run one.

- **They're on by default.** Servers send notifications through the project's relay, `https://relay.mgalazka.pl`, which the Zuna app registers with. There's nothing to set.
- **To use another relay,** set `ZUNA_PUSH_RELAYS` to it, such as `https://push.example.com`. With Docker, pass it like `ZUNA_DOMAIN`. From source on Linux, use the script's `--push-relays` option, or `--relay` to run your own next to the server, which points the server at it ([LINUX.md](LINUX.md)). Phones only register with a relay their app was built for.
- **To turn them off,** set `ZUNA_PUSH_RELAYS=off`. Everything else works, and phones see new messages when they open the app.
- **Several devices:** notifications go where you are, as in Telegram. While you use the desktop app, your phone stays quiet. After the desktop's away time, or when its screen locks, your phone gets them instead. What you read on one device disappears from the others.

## Choosing emotes

By default a server uses 7TV's global emotes. To change the set, find one on [7tv.app](https://7tv.app), copy its link, and paste it under **Server settings → Emotes**. Everyone on the server shares that set, and members can't add their own.

Your server needs outbound HTTPS access to `7tv.io` and `cdn.7tv.app`. If it can't reach them, chat works normally without emotes.

## Backups

Everything lives in the data folder:

```
zuna.db      the database (encrypted messages, accounts)
files/       encrypted uploads
emotes/      cached 7TV images (safe to lose; re-downloaded when needed)
certs/       HTTPS certificates, with automatic HTTPS (safe to lose; re-issued when needed)
icon         your server's picture
```

The database uses write-ahead logging, so a plain file copy of a running server can be inconsistent. Either stop the server first, or use SQLite's backup command:

```bash
sqlite3 /var/lib/zuna/zuna.db ".backup '/backups/zuna.db'"
```

With Docker, the data is in the `zuna-data` volume. From source on Linux, it's in `/var/lib/zuna`, and a push relay's `/var/lib/zuna-push/handle.key` is worth keeping too.

A backup doesn't let you read anyone's messages, since they're encrypted, but keep it as safe as the server itself: as [SECURITY.md](../SECURITY.md) explains, what's in it lets someone try to guess weak passwords offline. It also lets someone sign in as any account that has an older kind of sign-in key, which an account has until it next signs in with an updated app. The server says how many are left when it starts. Restoring an old backup does roll back the state of conversations; clients repair themselves by rejoining, but messages sent after the backup was taken are lost.

## Moving to a new address

Sign-in keys are bound to your server's address, so a key one server collects is no use on another. That means **nobody can sign in with their password or recovery key at a new address**, though devices already signed in carry on. To move a server, keep it reachable at its old address too, for signing in there, and keep `ZUNA_PUBLIC_URL` set to that old address. Picking an address you'll keep from the start avoids this.

## Upgrading

**Docker:**

```bash
git pull
```

```bash
docker compose up -d --build
```

**From source on Linux:**

```bash
sudo /opt/zuna/deploy/update.sh
```

It pulls, builds, installs and restarts, and goes back to the previous build if the new one doesn't start. Your data and settings stay in place.

Database migrations run automatically on start. Back up first. Zuna doesn't keep compatibility with older versions yet, so update the server and the apps together.

## Troubleshooting

**"Couldn't reach that server."** Check that your domain points at the machine and ports 80 and 443 are open. Automatic HTTPS needs port 80 reachable from the internet. Behind your own proxy, check that it forwards WebSockets and that `https://chat.example.com/healthz` answers through it.

**Certificates aren't being issued.** With automatic HTTPS, Let's Encrypt must be able to reach your server on port 80, and rate-limits repeated failures. Check the server's logs. Behind your own proxy, certificates are the proxy's job.

**Lost your setup link.** It's printed on every start until an owner account exists. Restart the server and read the logs again.

**Lost the owner account.** The server can't recover it, because it never has your keys. Use your recovery key in the app under **Sign in → Forgot your password?**

**Emotes don't load.** Check that the server can reach `7tv.io` and `cdn.7tv.app`.

**Messages show "Waiting for this message's keys".** This resolves by itself once one of your devices that was online at the time has synced. It usually means a new device signed in before an older one caught up.

**Phones don't get notifications.**
- `ZUNA_PUSH_RELAYS` must list the relay the app registers with: by default it does, unless it's set to something else or `off`.
- In the app, Settings → Notifications says when a server doesn't send notifications through it.
- If you run the relay yourself, see [PUSH_RELAY.md](PUSH_RELAY.md).

**Logs.**
- With Docker: `docker compose logs -f zuna`.
- From source on Linux: `journalctl -u zuna -f`.
