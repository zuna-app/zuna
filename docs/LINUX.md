# Running Zuna on Linux without Docker

`deploy/update.sh` builds Zuna from this repository and runs it as systemd services. It can run the chat server, with [LiveKit](https://livekit.io) beside it for voice channels, the push relay ([PUSH_RELAY.md](PUSH_RELAY.md)), the web app ([WEB.md](WEB.md)), or any of them on one machine. They speak plain HTTP, for your own reverse proxy to put HTTPS in front, on this machine or another one. The same command installs and updates:

- **Pulls** the latest code, and if the script itself changed, runs the new version.
- **Builds** the server and the relay with Go. It installs Go if the machine doesn't have it. The web app also needs Node and Rust, which it installs only when you run the web app. LiveKit is built too, from the commit `deploy/livekit/version` names, with Zuna's patch, which keeps what LiveKit learns about the people who join out of its log ([SECURITY_DETAILS.md](SECURITY_DETAILS.md#voice-channels)). That takes about 900 MB of memory, swap included, and 1.5 GB of disk for Go's caches, and happens again only when the commit or the patch changes. On a machine with less memory free, the script stops before changing anything and says so: add swap, and run it again.
- **Installs** the binaries, users, folders, settings and services.
- **Restarts** each service and checks that it answers. If a new build doesn't start, it puts the previous one back.

It doesn't set up a reverse proxy or a firewall: those are yours. For the chat server alone, `deploy/install.sh` can do those too, as below.

## What you need

- **A Linux machine with systemd,** such as Debian, Ubuntu or Fedora. The script installs curl with apt or dnf if it's missing, but cloning needs git first: `sudo apt install git` or `sudo dnf install git`.
- **About 1 GB of memory for building,** or 2 GB with the web app, which also needs about 2 GB of disk for its tools. On a smaller machine, add a swap file first, which the installer offers to do.
- **A reverse proxy** with a domain for each part, such as `chat.example.com` for the server, `push.example.com` for the relay and `web.chat.example.com` for the web app. The web app's has to be its own, never the server's. A chat server without a domain, reached at the machine's IP address, needs no proxy.
- **For the relay,** an APNs key from the Apple Developer account that publishes the app. See [What it needs](PUSH_RELAY.md#what-it-needs).

## Installing

The quickest way is one command, which installs git where it's missing, gets the code into `/opt/zuna`, at the newest stable release unless it's given `--channel nightly`, and starts the installer below with any options given to it (`apps/site/public/install.sh`, served at zuna.chat):

```bash
curl -fsSL https://zuna.chat/install.sh | sudo sh
```

Or get the code yourself:

```bash
sudo git clone https://github.com/zuna-app/zuna.git /opt/zuna
```

### With the installer

For the chat server and LiveKit, the installer asks the questions, and changes nothing until you've seen what it will do and said yes:

```bash
sudo /opt/zuna/deploy/install.sh
```

1. **How people reach the server:** a domain, which it looks up to see whether it points here or is behind Cloudflare ([Behind Cloudflare](SELF_HOSTING.md#behind-cloudflare)), or this machine's IP address. It never asks a service on the internet for the machine's address: it offers the machine's own and lets you type another, such as a router's. Calls' media goes to that address, which LiveKit is told with `--voice-ip` rather than asking a STUN server.
2. **The reverse proxy,** for a domain. With nothing on ports 80 and 443 it offers to install Caddy, from the distribution's packages. With Caddy, nginx or Apache already there it offers to add a site to it, or to leave it to you, and when it's yours it shows what to add, saves it in `/etc/zuna/proxy`, and waits. With anything else on those ports, it's yours.
3. **The certificate,** when it sets up nginx or Apache: one already there that covers the domain, from certbot's or what nginx uses, one from Let's Encrypt through certbot, which renews it and reloads the proxy, or files of your own, which it checks against the domain and each other and doesn't renew. Caddy gets its own.
4. **The firewall:** with ufw or firewalld on, it offers to open what's needed. With SELinux on, it lets nginx or Apache connect to the server, by counting the server's port as a web port and turning on `httpd_can_network_relay`, which lets them reach web ports, rather than `httpd_can_network_connect`, which would let them reach any.

Then it runs `deploy/update.sh` with the answers, writes the proxy's site, checks the proxy's settings before reloading it and takes the site out again if they don't check out, and finally checks that the server answers at its address, WebSockets and `/livekit/` included. If something's wrong, it says what, such as a certificate for another name or a proxy that can't reach the server, and lets you check again. Then it shows the setup link, with a QR code, where a proxy you set up has to point, and which ports to open, each with what it's for, and to forward when the public address is a router's. Its log, setup link and all, is `/var/log/zuna-install.log`, which only root reads.

To set up without questions, as from cloud-init, give the answers as options, which `--help` lists:

```bash
sudo /opt/zuna/deploy/install.sh --domain chat.example.com --proxy auto --yes
```

Running it again on a machine that has Zuna offers to update it or to go through the questions again.

### The push relay alone

For a machine with the relay and nothing else, `deploy/install-relay.sh` asks for its domain, the APNs key, the address to listen on, for a proxy on another machine, and that proxy's address, and runs this script with them:

```bash
sudo /opt/zuna/deploy/install-relay.sh
```

### With the script alone

Run the script once, saying what runs on this machine. For the chat server alone:

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com
```

For the server and the relay together, with the APNs key you downloaded:

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com --relay push.example.com --apns-key AuthKey_ABC123DEFG.p8 --apns-key-id ABC123DEFG
```

The relay can also run on its own machine, with only `--relay`, `--apns-key` and `--apns-key-id`. Without an APNs key, or with one Apple refuses, the relay runs, but phones can't register and pushes fail until you add the right one. The script shows what Apple said about the key.

To let people use Zuna in a browser too, add the web app, on a domain of its own:

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com --web web.chat.example.com
```

Its sign-in form starts with the server on this machine. The first build of the web app takes about 15 minutes on a machine with 4 cores, and longer on a smaller one, because it installs Node, Rust and `wasm-bindgen` and compiles the encryption core. Later updates reuse them and take seconds. [WEB.md](WEB.md) says what to know before offering the web app to people.

To add voice channels, run LiveKit beside the server:

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com --voice on
```

LiveKit is the media server for calls, and only ever carries encrypted media. Apps reach it through the server's own domain, at `/livekit/`, so it needs no domain, certificate or proxy setup of its own. Calls' media goes straight to this machine, though, not through the proxy, so open its ports to everyone (see [Voice channels](#voice-channels)).

The domains are where people reach Zuna through your proxy. The server puts its domain in invite links. On this machine:

- the server listens on port 9660;
- the relay listens on port 8090;
- the web app listens on port 8081;
- all of them listen only on this machine, unless you say otherwise with `--listen`;
- LiveKit listens on port 7880 for the server alone, on this machine whatever `--listen` says, and on 7881/tcp and 7882/udp for calls' media: 7881 on every address, and 7882 on each address the machine has when LiveKit starts, which waits for the network to have a default route.

The script prints the addresses to point the proxy at. When the server starts for the first time, the script also prints a one-time setup link. Once the proxy is set up, paste the link into the Zuna app to create the owner account, as in [Finish setup](SELF_HOSTING.md#finish-setup). If you miss it:

```bash
journalctl -u zuna | grep invite
```

## Your reverse proxy

For each domain, the proxy must:

- **handle HTTPS;**
- **forward WebSockets,** which the server uses for everything live;
- **add the client's address to `X-Forwarded-For`,** which both services use for rate limiting. Only the entries the proxy added count, so a caller can't make up their own;
- **keep no access log, and no log of requests' errors,** where nginx writes the caller's address and the whole request when the server behind it fails, and Caddy too unless an error route answers, as below. Everything people add to a conversation goes to `/api/sealed/` without a name, and the server keeps no address with it, but a log of every request's address would go a long way to saying who sent each message, and the addresses asked for at `/livekit/` hold voice tokens. The sites the installer writes keep neither from November 12, 2026. One it wrote before keeps both until `deploy/install.sh` runs again;
- **allow request bodies of at least 64 MB.** Files upload in 1 MiB chunks, so that's not for them: a change to who's in a group carries the group's whole tree, a few kilobytes for each device with post-quantum keys, which in a group of a thousand devices is tens of megabytes. With less, adding someone to a large group fails. A site the installer wrote before November 11, 2026 allows 2 MB, which is enough for groups of up to about fifty devices.

The web app's domain needs only HTTPS and `X-Forwarded-For`. Don't add security headers there: the web app sends its own, and a proxy that changes them can weaken them.

With `10.0.0.5` standing for this machine's address:

**Caddy**
```
# A failed request logged at debug alone, so that it doesn't write who asked, and what.
(quiet) {
    handle_errors {
        respond "{err.status_code} {err.status_text}"
    }
}

chat.example.com {
    reverse_proxy 10.0.0.5:9660
    import quiet
}

push.example.com {
    reverse_proxy 10.0.0.5:8090
    import quiet
}

web.chat.example.com {
    reverse_proxy 10.0.0.5:8081
    import quiet
}
```

**nginx**
```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # your ssl_certificate lines here
    access_log off;
    error_log /dev/null;

    client_max_body_size 64m;

    location / {
        proxy_pass http://10.0.0.5:9660;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
}

server {
    listen 443 ssl;
    server_name push.example.com;
    # your ssl_certificate lines here
    access_log off;
    error_log /dev/null;

    location / {
        proxy_pass http://10.0.0.5:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}

server {
    listen 443 ssl;
    server_name web.chat.example.com;
    # your ssl_certificate lines here
    access_log off;
    error_log /dev/null;

    location / {
        proxy_pass http://10.0.0.5:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

**By default the services listen only on this machine,** which is right for a proxy on the same machine. For a proxy on another machine, listen on this machine's private address with `--listen 10.0.0.5`, or on every address with `--listen 0.0.0.0`, and keep these in mind:

- **They speak plain HTTP,** and sign-in tokens pass over it. Keep the two machines on a private network, or put TLS between them, for example with WireGuard.
- **Let only the proxy reach ports 9660, 8090 and 8081.** With ufw, and `10.0.0.2` standing for the proxy's address:

  ```bash
  sudo ufw allow from 10.0.0.2 to any port 9660,8090,8081 proto tcp
  ```

- **Only a trusted proxy can name a caller's address.** That's this machine and private networks by default. A connection from anywhere else is taken at face value, so a public proxy needs `--trusted-proxies 203.0.113.7`, or its callers all count as one address for rate limits. A list replaces the default, so it's also how to narrow it down to exactly your proxy. Cloudflare's addresses never count: behind Cloudflare, `--behind-cloudflare on` takes the caller from what Cloudflare says instead, which `deploy/install.sh` and `deploy/install-relay.sh` set when the domain is behind it. When the proxy is on another machine, both installers ask for its address and trust it alone.

## Voice channels

With `--voice on`, the proxy needs nothing more: apps' signaling goes to `/livekit/` on the server's domain, over a WebSocket, like everything else there. Media doesn't go through the proxy. Open **7881/tcp** and **7882/udp** to everyone, straight to the machine that runs LiveKit. UDP is much better for calls, and TCP is for people whose networks block it, and for members who go through a SOCKS5 proxy that carries no UDP, as Tor doesn't. With ufw:

```bash
sudo ufw allow 7881/tcp
```

```bash
sudo ufw allow 7882/udp
```

LiveKit tells apps where to send media. With `--voice-ip 203.0.113.7`, which the installer always gives, or a server without a domain, that's the address given. Otherwise LiveKit finds the machine's public address when it starts, by asking a public STUN server, which apps on the machine's own network may not reach. Behind a router, forward both ports to the machine. With the proxy on another machine, people's media still comes to this one, so it has to be reachable from the internet on those two ports.

## Without a domain

With an IP address in place of the domain, the server serves HTTPS itself, with a certificate of its own that its links pin, as [Without a domain](SELF_HOSTING.md#without-a-domain) explains. It needs no proxy, listens on every address on `--server-port`, which has to be 1024 or above, and LiveKit gives apps that address for calls' media:

```bash
sudo /opt/zuna/deploy/update.sh --server 203.0.113.7 --voice on
```

Open the port to everyone, with 7881/tcp and 7882/udp, and back up `/var/lib/zuna/certificate.key`.

## Updating

```bash
sudo zuna-update
```

That's `/usr/local/sbin/zuna-update`, which runs `deploy/update.sh` from the checkout, with any options given to it. It remembers what runs on the machine, in `/etc/zuna/update.conf`. Add `--test` to run the server's tests before installing anything. If a new build doesn't start, the script prints the service's log, puts the previous build back and exits with an error.

On a terminal it shows its steps, each with how long it took and what it has to say, and keeps the rest in `/var/log/zuna-update.log`, which a failure shows the end of. `--verbose` prints everything as it goes instead. When nothing is new, no option changes anything and every service is running, it builds and restarts nothing, since a restart would end every call and connection for nothing: `/etc/zuna/built` holds the commit whose build is running, written once everything it changed has started. `--rebuild` builds, installs and restarts anyway. Only one update runs at a time.

**By itself.** `--auto-update on`, which the installer asks about, has a systemd timer, `zuna-update.timer`, run `zuna-update` every night between 4 and 5 in the machine's time, or at the next start after a night it was off, and `--auto-update off` takes it away. With nothing new, that's over in seconds. `journalctl -u zuna-update` says what each night did.

The script runs as root, but building doesn't: that's done by a `zuna-build` user, since it runs code from the repository. So that the script itself can't be changed by anyone else, it refuses to run from a checkout that someone other than root can write to, and says how to fix that. `--allow-user-checkout` runs it anyway, and has the checkout's owner build, at the cost of them being root at the next update.

**What gets installed.** Stable releases, by default: each update builds the newest stable release's tag, such as `v0.2.0`, the code its apps were released from, and never a nightly's. `--channel nightly` builds `main`'s newest commit instead, which has every change first and is tested less, and `--channel stable` goes back. As in the apps, going back waits: a server that ran nightly stays as it is until a stable release has a higher build, the number of commits behind it, so that its data never meets code older than what wrote it. Both installers ask which, stable by default. While no stable release is out, a new server on stable starts on `main`'s newest commit and waits there for the first one, which its next update after it's out then builds.

**Signatures.** Until a release's tag is signed by a key this machine trusts, a stable release is built with a warning, so someone who took over the repository would be running code on every server that updates. Tell git to trust the signer's key, with the key in root's GPG keyring or `gpg.ssh.allowedSignersFile` for SSH signatures. The next update that finds a stable release whose tag's signature checks out builds that, and from then on only that: nothing is built or run until `git verify-tag` accepts the newest stable release's signature, and an update without one changes nothing. `--signed-tags` asks for this from the start. Nightly is commits nothing signs, whatever this says. Each is remembered like the other options.

## Changing things later

Run the script again with the option you're changing. The others stay as they were.

| To | Run the script with |
|---|---|
| Add the relay to a machine that runs the server | `--relay push.example.com --apns-key … --apns-key-id …` |
| Add or replace the APNs key | `--apns-key AuthKey_….p8 --apns-key-id …` |
| Let the server use a relay on another machine | `--push-relays https://push.example.com` |
| Turn phone notifications off | `--push-relays off` |
| Keep the server's data in [PostgreSQL](SELF_HOSTING.md#postgresql) | `--database-url postgres://zuna:password@localhost/zuna`, kept only in `/etc/zuna/zuna.env`. A server moved to it starts out empty. `--database-url ""` goes back to SQLite |
| Add the web app to a machine that runs the server | `--web web.chat.example.com` |
| Start the web app's sign-in form with another server | `--web-server https://chat.example.com` |
| Let the web app connect only to some servers | `--web-servers https://chat.example.com`, or `--web-servers any` to allow any again |
| Stop the web app's host fetching pages for link previews | `--web-previews off` |
| Add voice channels to a machine that runs the server | `--voice on` |
| Turn voice channels off | `--voice off`. Channels stay, but nobody can join a call |
| Give LiveKit other ports | `--voice-port 9880`, which only the server uses, and `--voice-tcp-port 9881`, `--voice-udp-port 9882` for media |
| Tell LiveKit the address calls' media reaches | `--voice-ip 203.0.113.7`, or `--voice-ip ""` to have it ask a STUN server |
| Go by the machine's IP address, without a domain | `--server 203.0.113.7` |
| Listen somewhere else | `--listen 10.0.0.5` for a proxy on another machine, or `--listen 127.0.0.1` for one on this machine |
| Say exactly which proxies to trust | `--trusted-proxies 203.0.113.7,10.0.0.0/24` |
| Say the domains are behind Cloudflare's proxy | `--behind-cloudflare on` |
| Use other ports | `--server-port 9080`, `--relay-port 9090`, `--web-port 9081` |
| Run nightly, `main`'s newest commit, or stable releases again | `--channel nightly`, `--channel stable` |
| Update by itself every night, or stop | `--auto-update on`, `--auto-update off` |
| Build, install and restart even with nothing new | `--rebuild` |
| Build what's checked out, without pulling | `--no-pull` |

The script writes `/etc/zuna/zuna.env`, `/etc/zuna/push.env`, `/etc/zuna/zuna-web.env` and `/etc/zuna/livekit.yaml` the first time, and again only when you pass options that change them. A `livekit.yaml` from before it had a `room:` section gets one added, with the codecs that let a Mac encode a shared screen on its GPU, and one from before it had `packet_buffer_size_video` gets that under `rtc:`, which keeps a shared screen going on a network that loses packets. Each restarts LiveKit once. Anything you add to them by hand stays until the script writes that file again, which it does whenever you give an option for it, `--server` included, even with the same value, as running `deploy/install.sh` again does. `zuna.env` keeps only `ZUNA_DATABASE_URL` then, so add anything else, such as `ZUNA_DOWNLOAD_URL` from [Configuration](SELF_HOSTING.md#configuration), again afterwards. Restart the service after editing them:

```bash
sudo systemctl restart zuna
```

An update restarts LiveKit only when it brings a new LiveKit or new settings for it, since that ends every call.

## Where everything is

| What | Where |
|---|---|
| Chat server | `/usr/local/bin/zuna-server`, service `zuna`, settings `/etc/zuna/zuna.env`, data `/var/lib/zuna` |
| Push relay | `/usr/local/bin/zuna-push`, service `zuna-push`, settings `/etc/zuna/push.env`, handle key `/var/lib/zuna-push/handle.key` |
| Web app | `/usr/local/bin/zuna-web`, with the app inside it, service `zuna-web`, settings `/etc/zuna/zuna-web.env`. It keeps no data |
| LiveKit | `/usr/local/bin/livekit-server`, service `zuna-livekit`, settings `/etc/zuna/livekit.yaml`. It keeps no data |
| LiveKit's key and secret | `/etc/zuna/livekit-keys.yaml`, made once and readable only by LiveKit, and a copy in `/etc/zuna/zuna.env`, which only root reads |
| What LiveKit is built with | Go's modules and build cache in the builder's `~/go` and `~/.cache/go-build`, shared with the server's build |
| What the web app is built with | Node in `/usr/local/node`, Rust and `wasm-bindgen` in the builder's `~/.cargo`, and a copy of the code in its `~/.cache/zuna-web-build` |
| APNs key | `/etc/zuna/apns.p8`, readable only by the relay |
| What the script set up | `/etc/zuna/update.conf` |
| The update command | `/usr/local/sbin/zuna-update`, with its log in `/var/log/zuna-update.log` and the commit whose build runs in `/etc/zuna/built` |
| The nightly update | `/etc/systemd/system/zuna-update.timer` and `zuna-update.service`, from `deploy/` |
| What the installer did | `/var/log/zuna-install.log`, with the setup link in it, so only root reads it |
| The proxy's site, from the installer | `/etc/caddy/Caddyfile.d/zuna.caddyfile`, with an `import` line added to the Caddyfile where it had none, `/etc/nginx/sites-available/zuna.conf` or `conf.d/zuna.conf`, `/etc/apache2/sites-available/zuna.conf` or `/etc/httpd/conf.d/zuna.conf`, and for a proxy you set up, what to add in `/etc/zuna/proxy` |
| The previous build | `/usr/local/bin/zuna-server.previous`, `zuna-push.previous`, `zuna-web.previous` and `livekit-server.previous` |

**Back up** `/var/lib/zuna`, as described in [Backups](SELF_HOSTING.md#backups), and `/var/lib/zuna-push/handle.key`. If the handle key is lost, every phone's registration breaks until its app registers again, which it does when it next opens.

## Uninstalling

Run the installer again and pick Uninstall:

```bash
sudo /opt/zuna/deploy/install.sh
```

It takes away Zuna's services, its programs and settings in `/etc/zuna`, the nightly update, its build cache and the site it added to Caddy, nginx or Apache, and asks whether to delete the data in `/var/lib/zuna` too, which it asks twice, as nobody can get it back. Kept, setting Zuna up again here carries on with it. Deleted, its system users go with it. The proxy itself, its certificates, the firewall's rules, a swap file, Go and Node in `/usr/local`, data in PostgreSQL and the checkout stay.

## Logs and troubleshooting

```bash
journalctl -u zuna -f
```

```bash
journalctl -u zuna-push -f
```

```bash
journalctl -u zuna-web -f
```

```bash
journalctl -u zuna-livekit -f
```

- **The app can't connect:** check that the proxy forwards WebSockets, and that `https://chat.example.com/healthz` answers through it.
- **nginx or Apache answers 502 or 503 under SELinux,** as on Fedora: SELinux stops them connecting to the server. Let them, as the installer does:

  ```bash
  sudo semanage port -a -t http_port_t -p tcp 9660
  ```

  ```bash
  sudo setsebool -P httpd_can_network_relay 1
  ```
- **The build runs out of memory:** add swap, or build on a bigger machine. The web app's encryption core needs the most.
- **Voice channels can't be joined:** check that `/etc/zuna/zuna.env` has the `ZUNA_LIVEKIT_` settings, which `--voice on` adds, and that `zuna-livekit` is running.
- **People join a call but hear nothing:** media can't reach the machine. Check that 7881/tcp and 7882/udp are open to everyone, and forwarded if it's behind a router. LiveKit's log says which public address it found when it started.
- **No call connects, from anywhere, and LiveKit's log has `removing participant without connection`:** check that LiveKit has 7882/udp open, with `sudo ss -ulpn | grep livekit`. It opens it on the machine's addresses as it starts, and never on one that comes later, so if the machine's address changed since, restart it with `sudo systemctl restart zuna-livekit`. TCP can't make up for it then: 7881 listens on every address, but LiveKit only tells apps to use it at the addresses it found as it started, so no call connects over either.
- **The web app says it has to be opened over HTTPS:** reach it through the proxy, at `https://web.chat.example.com`, not at its port.
- **Phones don't get notifications:**
  - the server's `ZUNA_PUSH_RELAYS` must list the relay's public address. By default it lists the project's relay, `https://relay.zuna.chat`, and the script sets it to the relay on the same machine;
  - the relay needs an APNs key;
  - the app must be built with that address in its `ZUNA_PUSH_RELAY` setting.
