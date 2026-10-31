# Running Zuna on Linux without Docker

`deploy/update.sh` builds Zuna from this repository and runs it as systemd services. It can run the chat server, the push relay ([PUSH_RELAY.md](PUSH_RELAY.md)), or both on one machine. They speak plain HTTP, for your own reverse proxy to put HTTPS in front, on this machine or another one. The same command installs and updates:

- **Pulls** the latest code, and if the script itself changed, runs the new version.
- **Builds** the server and the relay with Go. It installs Go if the machine doesn't have it.
- **Installs** the binaries, users, folders, settings and services.
- **Restarts** each service and checks that it answers. If a new build doesn't start, it puts the previous one back.

It doesn't set up a reverse proxy or a firewall: those are yours.

## What you need

- **A Linux machine with systemd,** such as Debian, Ubuntu or Fedora. The script installs git and curl with apt or dnf if they're missing.
- **About 1 GB of memory for building.** On a smaller machine, add a swap file first.
- **A reverse proxy** with a domain for each part, such as `chat.example.com` for the server and `push.example.com` for the relay.
- **For the relay,** an APNs key from the Apple Developer account that publishes the app. See [What it needs](PUSH_RELAY.md#what-it-needs).

## Installing

Get the code. If the repository is private, clone it with a deploy key or an access token.

```bash
sudo git clone https://github.com/SocketByte/zuna-chat.git /opt/zuna
```

Then run the script once, saying what runs on this machine. For the chat server alone:

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com
```

For the server and the relay together, with the APNs key you downloaded:

```bash
sudo /opt/zuna/deploy/update.sh --server chat.example.com --relay push.example.com --apns-key AuthKey_ABC123DEFG.p8 --apns-key-id ABC123DEFG
```

The relay can also run on its own machine, with only `--relay`, `--apns-key` and `--apns-key-id`. Without an APNs key, the relay runs and phones can register, but pushes fail until you add one.

The domains are where people reach Zuna through your proxy. The server puts its domain in invite links. On this machine:

- the server listens on port 8080;
- the relay listens on port 8090;
- both listen on every address, so a proxy on another machine can reach them.

The script prints the addresses to point the proxy at. When the server starts for the first time, the script also prints a one-time setup link. Once the proxy is set up, paste the link into the Zuna app to create the owner account, as in [Finish setup](SELF_HOSTING.md#finish-setup). If you miss it:

```bash
journalctl -u zuna | grep invite
```

## Your reverse proxy

For each domain, the proxy must:

- **handle HTTPS;**
- **forward WebSockets,** which the server uses for everything live;
- **add the client's address to `X-Forwarded-For`,** which both services use for rate limiting. Only the entries the proxy added count, so a caller can't make up their own;
- **allow request bodies of at least 2 MB.** Files upload in 1 MiB chunks, so the limit doesn't need to match the largest file.

With `10.0.0.5` standing for this machine's address:

**Caddy**
```
chat.example.com {
    reverse_proxy 10.0.0.5:8080
}

push.example.com {
    reverse_proxy 10.0.0.5:8090
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
        proxy_pass http://10.0.0.5:8080;
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

    location / {
        proxy_pass http://10.0.0.5:8090;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

**By default the services listen only on this machine,** which is right for a proxy on the same machine. For a proxy on another machine, listen on this machine's private address with `--listen 10.0.0.5`, or on every address with `--listen 0.0.0.0`, and keep these in mind:

- **They speak plain HTTP,** and sign-in tokens pass over it. Keep the two machines on a private network, or put TLS between them, for example with WireGuard.
- **Let only the proxy reach ports 8080 and 8090.** With ufw, and `10.0.0.2` standing for the proxy's address:

  ```bash
  sudo ufw allow from 10.0.0.2 to any port 8080,8090 proto tcp
  ```

- **Only a trusted proxy can name a caller's address.** That's this machine and private networks by default. A connection from anywhere else is taken at face value, so a public proxy needs `--trusted-proxies 203.0.113.7`, or its callers all count as one address for rate limits. A list replaces the default, so it's also how to narrow it down to exactly your proxy.

## Updating

```bash
sudo /opt/zuna/deploy/update.sh
```

It remembers what runs on the machine, in `/etc/zuna/update.conf`. Add `--test` to run the server's tests before installing anything. If a new build doesn't start, the script prints the service's log, puts the previous build back and exits with an error.

The script runs as root, but building doesn't: that's done by the checkout's owner, or by a `zuna-build` user if root owns it, since it runs code from the repository.

**Only install what's been signed, if you like.** By default the script builds the branch's newest commit, so someone who took over the repository would be running code on every server that updates. With `--signed-tags`, it builds the newest `v*` tag instead, and only if `git verify-tag` accepts its signature, so nothing runs before that's checked. It needs tags signed by a key you've told git to trust: the signer's key in the checkout owner's GPG keyring, or `gpg.ssh.allowedSignersFile` for SSH signatures. The choice is remembered like the other options.

## Changing things later

Run the script again with the option you're changing. The others stay as they were.

| To | Run the script with |
|---|---|
| Add the relay to a machine that runs the server | `--relay push.example.com --apns-key … --apns-key-id …` |
| Add or replace the APNs key | `--apns-key AuthKey_….p8 --apns-key-id …` |
| Let the server use a relay on another machine | `--push-relays https://push.example.com` |
| Turn phone notifications off | `--push-relays off` |
| Listen somewhere else | `--listen 10.0.0.5` for a proxy on another machine, or `--listen 127.0.0.1` for one on this machine |
| Say exactly which proxies to trust | `--trusted-proxies 203.0.113.7,10.0.0.0/24` |
| Use other ports | `--server-port 9080`, `--relay-port 9090` |
| Build what's checked out, without pulling | `--no-pull` |

The script writes `/etc/zuna/zuna.env` and `/etc/zuna/push.env` the first time, and again only when you pass options that change them. Anything else you add to them by hand stays, such as `ZUNA_DOWNLOAD_URL` from [Configuration](SELF_HOSTING.md#configuration). Restart the service after editing them:

```bash
sudo systemctl restart zuna
```

## Where everything is

| What | Where |
|---|---|
| Chat server | `/usr/local/bin/zuna-server`, service `zuna`, settings `/etc/zuna/zuna.env`, data `/var/lib/zuna` |
| Push relay | `/usr/local/bin/zuna-push`, service `zuna-push`, settings `/etc/zuna/push.env`, handle key `/var/lib/zuna-push/handle.key` |
| APNs key | `/etc/zuna/apns.p8`, readable only by the relay |
| What the script set up | `/etc/zuna/update.conf` |
| The previous build | `/usr/local/bin/zuna-server.previous` and `zuna-push.previous` |

**Back up** `/var/lib/zuna`, as described in [Backups](SELF_HOSTING.md#backups), and `/var/lib/zuna-push/handle.key`. If the handle key is lost, every phone's registration breaks until its app registers again, which it does when it next opens.

## Logs and troubleshooting

```bash
journalctl -u zuna -f
```

```bash
journalctl -u zuna-push -f
```

- **The app can't connect:** check that the proxy forwards WebSockets, and that `https://chat.example.com/healthz` answers through it.
- **The build runs out of memory:** add swap, or build on a bigger machine.
- **Phones don't get notifications:**
  - the server's `ZUNA_PUSH_RELAYS` must list the relay's public address. By default it lists the project's relay, `https://relay.mgalazka.pl`, and the script sets it to the relay on the same machine;
  - the relay needs an APNs key;
  - the app must be built with that address in its `ZUNA_PUSH_RELAY` setting.
