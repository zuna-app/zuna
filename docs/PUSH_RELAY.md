# The push relay

Phones can't keep a connection open in the background, so a Zuna server wakes them through Apple's push service. Apple accepts pushes only from whoever holds the published app's push key. Self-hosted servers can't hold that key, so they send pushes through `zuna-push`, a small relay that the project runs. Its code is in `server/cmd/zuna-push` and `server/internal/relay`.

## What the relay sees

- **Phones** register their Apple push token and get back a handle: the token sealed with the relay's own key. The relay keeps no list of devices, and servers never see tokens.
- **Servers** post a handle and a payload that the server already sealed for the phone. The payload holds only the group and message IDs. The relay passes it to Apple unchanged, as an alert, or as a silent push that tells the phone to clear a chat read or a message deleted elsewhere.
- **So the relay learns** which server addresses send pushes, when they send them, and how big the sealed payloads are. It never learns who uses which server, who wrote what, or anything about a message. The phone fetches the message from its server and decrypts it.

## What it needs

- **An APNs key** from the Apple Developer account that publishes the app: Certificates, IDs & Profiles → Keys → **+** → Apple Push Notifications service (APNs). Download the `.p8` file (Apple offers it only once) and note its Key ID. One key works for the sandbox and production environments, and for every app on the team.
- **A domain** for the relay, such as `push.example.com`, with HTTPS.
- **A machine with Docker.** The relay needs very little memory and CPU.

## Running it

**Without Docker,** on Linux with systemd, `deploy/update.sh` builds and runs the relay, alone or next to a chat server, for your own reverse proxy to put HTTPS in front. See [LINUX.md](LINUX.md):

```bash
sudo /opt/zuna/deploy/update.sh --relay push.example.com --apns-key AuthKey_ABC123DEFG.p8 --apns-key-id ABC123DEFG
```

**With Docker,** put the `.p8` file next to a `docker-compose.yml` like this one, in a checkout of the repository:

```yaml
services:
  push:
    build:
      context: ./server
      dockerfile: Dockerfile.push
    restart: unless-stopped
    environment:
      ZUNA_PUSH_APNS_KEY: /secrets/apns.p8
      ZUNA_PUSH_APNS_KEY_ID: ABC123DEFG # the key's ID
      ZUNA_PUSH_TRUST_PROXY: "true"
    volumes:
      - ./apns.p8:/secrets/apns.p8:ro
      - push-data:/data
  caddy:
    image: caddy:2
    restart: unless-stopped
    command: caddy reverse-proxy --from push.example.com --to push:8090
    ports: ["80:80", "443:443"]
    volumes:
      - caddy-data:/data

volumes:
  push-data:
  caddy-data:
```

Then run `docker compose up -d`.

| Environment | Default | Purpose |
|---|---|---|
| `ZUNA_PUSH_APNS_KEY` | | The `.p8` file. Without it, phones can register but pushes fail |
| `ZUNA_PUSH_APNS_KEY_ID` | | The key's ID |
| `ZUNA_PUSH_APNS_TEAM` | `SGKB9R23YT` | The team that publishes the app |
| `ZUNA_PUSH_APNS_TOPIC` | `chat.zuna.mobile` | The app's bundle ID |
| `ZUNA_PUSH_LISTEN` | `127.0.0.1:8090` (`:8090` in Docker) | Where to listen, behind the proxy that adds HTTPS |
| `ZUNA_PUSH_DATA` | `./zuna-push-data` (`/data` in Docker) | Holds `handle.key` |
| `ZUNA_PUSH_TRUST_PROXY` | `false` | Take callers' addresses from the proxy's `X-Forwarded-For`, for rate limits |

**Back up `handle.key`.** Every phone's handle is sealed with it. If it's lost, notifications stop until each app registers again, which it does when it next opens.

## Pointing servers and the app at it

- **The project's relay** runs at `https://relay.mgalazka.pl`.
- **Servers** list the relays that may wake their members' phones in `ZUNA_PUSH_RELAYS`. By default that's the project's relay, so self-hosters get notifications without setting anything. `off` turns them off.
- **The app** registers with the relay in its `ZUNA_PUSH_RELAY` build setting (`apps/ios/project.yml`), the project's relay. Debug builds use Apple's sandbox, and TestFlight and App Store builds use production. The relay handles both with one key.

## The notification filtering entitlement

Muted chats shouldn't notify, but an extension can hide a notification only with Apple's notification filtering entitlement (`com.apple.developer.usernotifications.filtering`). Until Apple grants it, the app tells each server which chats are muted, and the server skips them. Mentions in muted chats then don't notify.

The Account Holder applies at developer.apple.com/contact/request/notification-filtering. A description along these lines fits:

> Zuna is an end-to-end encrypted messenger. Our servers can't read messages, so a push only says that a message arrived, and our Notification Service Extension fetches and decrypts it on the device. Whether to show it depends on things only the device knows, such as chats the person muted (unless the message mentions them), messages deleted before the push arrived, and messages the person already read on another device. Without filtering, we would have to tell our servers which chats each person muted.

Once it's granted, add the entitlement to `ZunaNotifications` in `apps/ios/project.yml` and set `PushStore.canFilter` to `true`. The extension then drops what shouldn't show, and the app stops sending muted chats to servers.
