# Self-hosting Zuna

A Zuna server is one program and one data folder. There's no separate database, cache or queue to run.

**You'll need:**
- A machine that stays on. The smallest VPS plans are a reasonable starting point for a friend group, and storage grows with the files people send.
- A domain name pointing at it, such as `chat.example.com`.
- Ports 80 and 443 open, unless you use your own reverse proxy.

Each install is one community with its own members. To host two separate communities, run two installs.

## Option 1: Docker (recommended)

```bash
git clone https://github.com/zuna-chat/zuna.git
```

```bash
cd zuna/deploy
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

This builds the server from the repository, creates a `zuna` system user, starts a hardened systemd service and puts Caddy in front for HTTPS. It prints your setup link at the end. Running the same script again updates everything. Data goes in `/var/lib/zuna`. The details, including running the push relay on the same machine, are in [LINUX.md](LINUX.md).

## Option 3: Run the binary yourself

Download the file for your platform from the [releases page](https://github.com/zuna-chat/zuna/releases), then:

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

If Caddy, nginx or Traefik already handles HTTPS on your machine, run Zuna on plain HTTP behind it:

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

Set `ZUNA_TRUST_PROXY=true` only behind a proxy, so that rate limiting sees members' real addresses. Without a proxy, it would let anyone fake their address.

## Configuration

Everything can be set by flag or environment variable.

| Flag | Environment | Default | Purpose |
|---|---|---|---|
| `--domain` | `ZUNA_DOMAIN` | | Turns on automatic HTTPS on ports 80 and 443 |
| `--data` | `ZUNA_DATA` | `./zuna-data` | Where everything is stored |
| `--listen` | `ZUNA_LISTEN` | `:8080` | Address to listen on when not using `--domain` |
| `--public-url` | `ZUNA_PUBLIC_URL` | From the domain | Address people use to reach this server |
| `--tls-cert`, `--tls-key` | `ZUNA_TLS_CERT`, `ZUNA_TLS_KEY` | | Use your own certificate files |
| `--trust-proxy` | `ZUNA_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` from a reverse proxy |
| `--download-url` | `ZUNA_DOWNLOAD_URL` | | Where invite pages link for downloading the app |
| `--auth-burst` | | `20` | Sign-in attempts allowed at once from one address |
| `--push-relays` | `ZUNA_PUSH_RELAYS` | | Comma-separated push relays that may wake phones for new messages. Phones register with one of them; with none, phones aren't notified |

The app only connects over HTTPS, except to `localhost`.

Everything else is in the app under **Server settings**: name and picture, invites, members, the 7TV emote set, the upload limit and message retention.

## Choosing emotes

By default a server uses 7TV's global emotes. To change the set, find one on [7tv.app](https://7tv.app), copy its link, and paste it under **Server settings → Emotes**. Everyone on the server shares that set, and members can't add their own.

Your server needs outbound HTTPS access to `7tv.io` and `cdn.7tv.app`. If it can't reach them, chat works normally without emotes.

## Backups

Everything lives in the data folder:

```
zuna.db      the database (encrypted messages, accounts)
files/       encrypted uploads
emotes/      cached 7TV images (safe to lose; re-downloaded when needed)
certs/       HTTPS certificates (safe to lose; re-issued when needed)
icon         your server's picture
```

The database uses write-ahead logging, so a plain file copy of a running server can be inconsistent. Either stop the server first, or use SQLite's backup command:

```bash
sqlite3 /var/lib/zuna/zuna.db ".backup '/backups/zuna.db'"
```

With Docker, the data is in the `zuna-data` volume.

A backup doesn't let you read anyone's messages, since they're encrypted. Restoring an old backup does roll back the state of conversations; clients repair themselves by rejoining, but messages sent after the backup was taken are lost.

## Upgrading

**Docker:**

```bash
git pull
```

```bash
docker compose up -d --build
```

**Install script:** run it again. Your data and settings stay in place.

Database migrations run automatically on start. Back up first.

## Troubleshooting

**"Couldn't reach that server."** Check that your domain points at the machine and ports 80 and 443 are open. Automatic HTTPS needs port 80 reachable from the internet.

**Certificates aren't being issued.** Let's Encrypt must be able to reach your server on port 80, and rate-limits repeated failures. Check the server's logs.

**Lost your setup link.** It's printed on every start until an owner account exists. Restart the server and read the logs again.

**Lost the owner account.** The server can't recover it, because it never has your keys. Use your recovery key in the app under **Sign in → Forgot your password?**

**Emotes don't load.** Check that the server can reach `7tv.io` and `cdn.7tv.app`.

**Messages show "Waiting for this message's keys".** This resolves by itself once one of your devices that was online at the time has synced. It usually means a new device signed in before an older one caught up.
