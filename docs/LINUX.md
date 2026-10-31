# Running Zuna on Linux without Docker

`deploy/update.sh` builds Zuna from this repository and runs it as systemd services. It can run the chat server, the push relay ([PUSH_RELAY.md](PUSH_RELAY.md)), or both on one machine, with Caddy in front to provide HTTPS. The same command installs and updates:

- **Pulls** the latest code, and if the script itself changed, runs the new version.
- **Builds** the server and the relay with Go. It installs Go if the machine doesn't have it.
- **Installs** the binaries, users, folders, settings and services.
- **Configures Caddy** for HTTPS. It installs Caddy if needed.
- **Restarts** each service and checks that it answers. If a new build doesn't start, it puts the previous one back.

## What you need

- **A Linux machine with systemd and apt or dnf,** such as Debian 12, Ubuntu 24.04 or Fedora.
- **About 1 GB of memory for building.** On a smaller machine, add a swap file first.
- **A domain for each part** that points at the machine, such as `chat.example.com` for the server and `push.example.com` for the relay.
- **Ports 80 and 443 open.** The script opens them in ufw if ufw is on, and other firewalls are up to you.
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

The relay can also run on its own machine, with only `--relay`, `--apns-key` and `--apns-key-id`.

When the server starts for the first time, the script prints a one-time setup link. Paste it into the Zuna app to create the owner account, as in [Finish setup](SELF_HOSTING.md#finish-setup). If you miss it:

```bash
journalctl -u zuna | grep invite
```

## Updating

```bash
sudo /opt/zuna/deploy/update.sh
```

It remembers what runs on the machine, in `/etc/zuna/update.conf`. Add `--test` to run the server's tests before installing anything. If a new build doesn't start, the script prints the service's log, puts the previous build back and exits with an error.

## Changing things later

Run the script again with the option you're changing. The others stay as they were.

| To | Run the script with |
|---|---|
| Add the relay to a machine that runs the server | `--relay push.example.com --apns-key … --apns-key-id …` |
| Add or replace the APNs key | `--apns-key AuthKey_….p8 --apns-key-id …` |
| Let the server use a relay on another machine | `--push-relays https://push.example.com` |
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
| HTTPS | Caddy, with Zuna's sites in `/etc/caddy/zuna.caddy` |
| The previous build | `/usr/local/bin/zuna-server.previous` and `zuna-push.previous` |

The server listens on `127.0.0.1:8080` and the relay on `127.0.0.1:8090`. Only Caddy faces the internet.

**Back up** `/var/lib/zuna`, as described in [Backups](SELF_HOSTING.md#backups), and `/var/lib/zuna-push/handle.key`. If the handle key is lost, every phone's registration breaks until its app registers again, which it does when it next opens.

## Logs and troubleshooting

```bash
journalctl -u zuna -f
```

```bash
journalctl -u zuna-push -f
```

```bash
journalctl -u caddy -f
```

- **Certificates don't work:** the domain must point at this machine, with ports 80 and 443 reachable from the internet. Caddy's log says what Let's Encrypt answered.
- **The build runs out of memory:** add swap, or build on a bigger machine.
- **Phones don't get notifications:**
  - the server's `ZUNA_PUSH_RELAYS` must list the relay's address;
  - the relay needs an APNs key;
  - the app must be built with that relay in its `ZUNA_PUSH_RELAY` setting.
