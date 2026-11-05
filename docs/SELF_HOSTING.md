# Self-hosting Zuna

A Zuna server is one program and one data folder. There's no separate database, cache or queue to run, though a large server can keep its data in [PostgreSQL](#postgresql) instead. The desktop apps and the iPhone and iPad app all connect to the same server.

**You'll need:**
- A machine that stays on. The smallest VPS plans are a reasonable starting point for a friend group, and storage grows with the files people send.
- A domain name pointing at it, such as `chat.example.com`, or an address that doesn't change, for [a server without a domain](#without-a-domain).
- Ports 80 and 443 open, unless you use your own reverse proxy.

Each install is one community with its own members. To host two separate communities, run two installs.

There are three ways to run it:

| | What it does | HTTPS |
|---|---|---|
| [Docker](#option-1-docker) | Builds and runs the server in a container | Automatic, or your own proxy |
| [The installer, on Linux](#option-2-the-installer-on-linux-with-systemd) | Asks a few questions, builds the server from git and runs it as a systemd service, without Docker, then checks that it answers. One command updates it | Caddy, set up for you, or your own proxy |
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

LiveKit, for [voice channels](#voice-channels) and calls, runs in a container next to it. Calls' media goes straight to it, so open 7881/tcp and 7882/udp as well as 80 and 443.

## Option 2: The installer, on Linux with systemd

On Debian, Ubuntu, Fedora or another Linux with systemd, on amd64 or arm64. A small machine may need git first, with `sudo apt install git` or `sudo dnf install git`.

```bash
sudo git clone https://github.com/SocketByte/zuna-chat.git /opt/zuna
```

```bash
sudo /opt/zuna/deploy/install.sh
```

It asks how people will reach the server, by a domain or by the machine's IP address, then about the reverse proxy and the firewall, and changes nothing until you've seen a summary and said yes. Then it builds the server from git, with LiveKit for [voice channels](#voice-channels), and runs both as hardened systemd services, with their data in `/var/lib/zuna`. The server never binds ports 80 and 443 itself: it listens on 8080, behind a proxy.

- **With nothing on ports 80 and 443,** it can install Caddy, which gets and renews the certificate.
- **With Caddy, nginx or Apache already there,** it can add a site for Zuna, checking the proxy's settings before reloading it and taking the site out again if they don't check out. nginx and Apache use a certificate already there that covers the domain, one from Let's Encrypt through certbot, or your own files.
- **Or you set the proxy up yourself,** on this machine or another, and the installer shows what to add and waits. The proxy has to pass WebSockets on, at `/api/ws` and `/livekit/`.
- **Without a domain,** the server serves HTTPS itself, on port 9660, as in [Without a domain](#without-a-domain), with no proxy.

At the end it checks that the server answers at its address, WebSockets and voice included, says what's wrong if it doesn't, and shows the setup link, with a QR code. To update later:

```bash
sudo zuna-update
```

It goes back to the previous build if a new one doesn't start. The details are in [LINUX.md](LINUX.md), including running the push relay or the web app on the same machine. For a server behind Cloudflare, see [Behind Cloudflare](#behind-cloudflare).

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

- **From source on Linux,** that's how it always runs: on port 8080. The installer can set up Caddy, nginx or Apache for it. See [Your reverse proxy](LINUX.md#your-reverse-proxy), which covers a proxy on another machine.
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

## Behind Cloudflare

Zuna works behind Cloudflare's proxy, WebSockets and uploads included. The installer notices Cloudflare in front of the domain and asks which SSL/TLS mode it's set to.

- **Use Full (strict).** Flexible sends everything between Cloudflare and your server unencrypted, sign-ins and session tokens included, for anyone on the way to read or change, though messages stay encrypted end to end. Full doesn't check your server's certificate. A Cloudflare origin certificate, made under SSL/TLS → Origin Server in Cloudflare's dashboard, is the simplest one for your proxy to use, as Let's Encrypt can't always get through Cloudflare.
- **Trust Cloudflare's addresses,** from [cloudflare.com/ips](https://www.cloudflare.com/ips/), in `ZUNA_TRUSTED_PROXIES`, as well as your own proxy's. Otherwise everyone counts as one of a few Cloudflare addresses for rate limits. The installer does this.
- **Calls don't go through Cloudflare.** Their media goes straight to your server on 7881/tcp and 7882/udp, so members in a call can see its real address.
- **Turn off Bot Fight Mode and Under Attack Mode** for the server's domain. The apps can't solve a challenge.

## Without a domain

A server can go by the machine's IP address instead, such as a box on your home network. Give the address where the domain would go:

```bash
ZUNA_DOMAIN=192.168.1.10 docker compose up -d
```

Or, with the binary:

```bash
./zuna-server --domain 192.168.1.10 --data /path/to/data
```

No certificate authority vouches for an address, so the server makes its own certificate, and listens only on port 443, or where `--listen` says. Its links carry a fingerprint of its key, called a pin, after the `#`, as they carry the community key. The apps trust that key for that address and nothing else, so nobody in between can pose as your server, though nobody signed its certificate. So:

- **Share links whole,** with everything after the `#`. To sign in on another device, enter the address the server prints at the start, which ends in `#pin=`, or paste any of its links. Members find that address in **Settings → Security**, under their devices.
- **Keep `certificate.key`** from the data folder with your backups. A new key means new links, and everyone signing out of the server and in again.
- **Keep the address the same.** It's how the apps find the server.
- **Calls go through the same ports as with a domain,** 7881/tcp and 7882/udp. The Docker setup has LiveKit give apps this address for their media, rather than the public one it would find through STUN, which apps on the same network may not reach. Running LiveKit yourself, start it with `--node-ip` set to the address, and `use_external_ip` off.
- **The web app can't reach it,** as a browser can't check a certificate by its key. The desktop app and the iPhone and iPad app can.

## Configuration

Everything can be set by flag or environment variable.

| Flag | Environment | Default | Purpose |
|---|---|---|---|
| `--domain` | `ZUNA_DOMAIN` | | Turns on automatic HTTPS on ports 80 and 443. With an IP address, HTTPS with the server's [own certificate](#without-a-domain) on 443 |
| `--data` | `ZUNA_DATA` | `./zuna-data` | Where everything is stored |
| `--database-url` | `ZUNA_DATABASE_URL` | | A [PostgreSQL](#postgresql) database to keep accounts and messages in, instead of `zuna.db` in the data folder |
| `--listen` | `ZUNA_LISTEN` | `:8080` | Address to listen on, unless `--domain` names a domain. With an IP address, `:443` by default |
| `--public-url` | `ZUNA_PUBLIC_URL` | From the domain | Address people use to reach this server |
| `--tls-cert`, `--tls-key` | `ZUNA_TLS_CERT`, `ZUNA_TLS_KEY` | | Use your own certificate files |
| `--trust-proxy` | `ZUNA_TRUST_PROXY` | `false` | Trust `X-Forwarded-For` from a reverse proxy on this machine or a private network |
| `--trusted-proxies` | `ZUNA_TRUSTED_PROXIES` | | Comma-separated addresses or CIDR ranges of the proxies to trust, instead of those networks |
| `--download-url` | `ZUNA_DOWNLOAD_URL` | | A link for downloading the app, which invite pages show as well as the official releases |
| `--auth-burst` | | `20` | Sign-in attempts allowed at once from one address, where an IPv6 /48 counts as one |
| `--user-quota-mb` | `ZUNA_USER_QUOTA_MB` | `10240` | How many MB of files each person may keep, and as many again of messages, or `-1` for no limit |
| `--push-relays` | `ZUNA_PUSH_RELAYS` | `https://relay.mgalazka.pl` | Comma-separated push relays that may wake phones for new messages, or `off` for none. Phones register with one of them |

The app only connects over HTTPS, except to `localhost`.

Everything else is in the app under **Server settings**: name and picture, invites, members, the 7TV emote set, the upload limit and message retention.

## PostgreSQL

Accounts, conversations and their encrypted messages are in `zuna.db`, a SQLite database in the data folder, which is enough for a few hundred active people. For a larger server, or to keep them with your other databases, Zuna can use PostgreSQL 15 or later instead, though not in the Docker setup, which keeps to `zuna.db`. Uploaded files stay in the data folder either way.

Give it a database of its own, owned by the account it signs in as:

```bash
sudo -u postgres createuser --pwprompt zuna
```

```bash
sudo -u postgres createdb --owner zuna zuna
```

Then give the server its address in `ZUNA_DATABASE_URL`, and it makes the tables when it starts:

```
ZUNA_DATABASE_URL=postgres://zuna:password@localhost/zuna
```

- **From source on Linux,** run the script with `--database-url postgres://…`. It keeps the address only in `/etc/zuna/zuna.env`, which only root reads.
- **On another machine,** add `?sslmode=verify-full`, so that the connection is encrypted and the database's certificate checked, with `&sslrootcert=/path/to/ca.crt` if your own authority signed it. Without `sslmode`, it's encrypted only if the database offers it, and nothing is checked.
- **In a database other programs use,** give Zuna a schema of its own with `?search_path=zuna`, which it makes if it may.

A server started on PostgreSQL starts out empty: there's no way yet to move what's in an existing `zuna.db` across.

## The web app

To let people use Zuna in a browser, run the web app's own program, `zuna-web`, on a domain of its own, such as `web.chat.example.com`. It isn't part of the server and never should be: [WEB.md](WEB.md) explains why, and how to run it.

## Voice channels

Voice channels and calls need [LiveKit](https://livekit.io), a media server that runs beside Zuna. It only ever carries encrypted media. Without it, everything else works, and voice channels can be made but not joined.

It doesn't need much, since it only passes media along. A small VPS is fine for a friend group, though it uses bandwidth: each person in a call receives everyone else's audio, at about 64 kbit/s each, and a shared screen can be 20 Mbit/s for each person watching. Server settings, Screen sharing, is where to say who can share, how many at once, and how large and how fast, and each voice channel can say otherwise. [SCREEN_SHARE.md](SCREEN_SHARE.md#what-a-server-says-and-what-a-device-chooses) has what each of those can really hold.

**With Docker,** it's part of the setup, with either compose file. Zuna makes the key the two share the first time it starts, in the `zuna-livekit` volume. Open 7881/tcp and 7882/udp in your firewall for calls' media.

**With the installer,** it's part of the setup. Running `deploy/update.sh` yourself, add `--voice on`, and it installs LiveKit and sets up both sides. [LINUX.md](LINUX.md#voice-channels) has the details.

**Otherwise,** run [LiveKit's own server](https://docs.livekit.io/home/self-hosting/deployment/) on the same machine, with an API key and a secret of at least 32 characters, and tell Zuna how to reach it. Give it the `room:` section of `LIVEKIT_CONFIG` in `deploy/docker-compose.yml` as well, which lets screens shared from a Mac be encoded on its GPU:

| Setting | Environment | |
|---|---|---|
| `--livekit-internal-url` | `ZUNA_LIVEKIT_INTERNAL_URL` | How Zuna reaches it, such as `http://127.0.0.1:7880` |
| `--livekit-key` | `ZUNA_LIVEKIT_KEY` | Its API key |
| `--livekit-secret` | `ZUNA_LIVEKIT_SECRET` | Its API secret |
| `--livekit-keys` | `ZUNA_LIVEKIT_KEYS` | Instead of those two, LiveKit's key file, of lines like `key: secret`, which Zuna makes with a new secret if it isn't there, readable only by the account Zuna runs as |
| `--livekit-url` | `ZUNA_LIVEKIT_URL` | Only if apps should reach it at an address of its own, such as `wss://voice.example.com`, with its own certificate |

Apps reach it through Zuna's own address, at `/livekit/`, so there's no second name or certificate to look after. A reverse proxy in front of Zuna has to allow WebSockets there, as it already does for `/api/ws`.

**Media doesn't go through Zuna.** Open **7881/tcp** and **7882/udp** on the machine for it, or whichever ports you gave LiveKit. UDP is much better for calls, and TCP is for people whose networks block it.

If you use the web app with `--servers`, and apps reach LiveKit at an address of its own, list that with `--media-servers` too.

## Phone notifications

Phones can't keep a connection open in the background, so the server wakes them through a push relay when a message arrives. The relay sees only that something arrived for some phone: the message stays encrypted on the server, and the phone fetches and decrypts it itself. [PUSH_RELAY.md](PUSH_RELAY.md) explains how it works and how to run one.

- **They're on by default.** Servers send notifications through the project's relay, `https://relay.mgalazka.pl`, which the Zuna app registers with. There's nothing to set.
- **To use another relay,** set `ZUNA_PUSH_RELAYS` to it, such as `https://push.example.com`. With Docker, pass it like `ZUNA_DOMAIN`. From source on Linux, use the script's `--push-relays` option, or `--relay` to run your own next to the server, which points the server at it ([LINUX.md](LINUX.md)). Phones only register with a relay their app was built for.
- **To turn them off,** set `ZUNA_PUSH_RELAYS=off`. Everything else works, and phones see new messages when they open the app.
- **Several devices:** notifications go where you are, as in Telegram. The device you're using notifies straight away. While you're on another one, or were in the last few minutes, the rest wait 30 seconds and skip anything you read in the meantime, so at the desktop your phone only buzzes for what you left unread. What you read on one device disappears from the others.

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
certificate.key  the key of the server's own certificate, without a domain (keep it: a new one needs new links)
icon         your server's picture
```

The database uses write-ahead logging, so a plain file copy of a running server can be inconsistent. Either stop the server first, or use SQLite's backup command:

```bash
sqlite3 /var/lib/zuna/zuna.db ".backup '/backups/zuna.db'"
```

With [PostgreSQL](#postgresql), back up the database with `pg_dump`, and the data folder's `files/` and `icon` as well:

```bash
pg_dump --format=custom --file=/backups/zuna.dump postgres://zuna:password@localhost/zuna
```

With Docker, the data is in the `zuna-data` volume. From source on Linux, it's in `/var/lib/zuna`, and a push relay's `/var/lib/zuna-push/handle.key` is worth keeping too.

A backup doesn't let you read anyone's messages, since they're encrypted, but keep it as safe as the server itself: as [SECURITY.md](../SECURITY.md) explains, what's in it lets someone try to guess weak passwords offline. Restoring an old backup does roll back the state of conversations; clients repair themselves by rejoining, but messages sent after the backup was taken are lost.

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

**With the installer, or `deploy/update.sh`:**

```bash
sudo zuna-update
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
