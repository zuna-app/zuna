# The push relay

Phones can't keep a connection open in the background, so a Zuna server wakes them through Apple's push service. Apple accepts pushes only from whoever holds the published app's push key. Self-hosted servers can't hold that key, so they send pushes through `zuna-push`, a small relay that the project runs. Its code is in `server/cmd/zuna-push` and `server/internal/relay`.

## What the relay sees

- **Phones** register their Apple push token and get back handles, one for each server they're on: the token sealed with the relay's own key, with when it was made. The relay first sends the phone a silent push with nothing in it, which the app ignores, and makes handles only if Apple takes it. Where CallKit is allowed, a phone registers its VoIP token with them, which calls ring through. The relay keeps no list of devices, and servers never see tokens. Every handle looks different and is the same length whatever it's for, so servers can't tell that their handles name the same phone, nor whether it runs a development build. A handle stops working after 60 days, and the app gets new ones each week that it's opened, so a server it left can wake it for at most that long.
- **Servers** post a handle and a payload that the server already sealed for the phone. The payload holds only the group and message IDs. The relay passes it to Apple unchanged, as an alert, or as a silent push that tells the phone to clear a chat read or a message deleted elsewhere. A call ringing goes through PushKit to a VoIP token, which the app hands to CallKit as a phone call, or as an alert with Answer and Decline to a phone without one, and lasts a minute: a ring has nothing to say later. A VoIP token takes nothing else, since iOS stops waking an app that doesn't report a call for each such push.
- **So the relay learns** which server addresses send pushes, when they send them, how big the sealed payloads are, and, since it opens each handle to reach Apple, which phone each push is for. It sees a phone register about once a week, when its app is opened, and when it joins a server. That does let whoever runs a relay, or Apple, see which phones get pushes from which server address and when, even though the relay keeps no list of them. It never learns who wrote what, or anything about a message: the phone fetches the message from its server and decrypts it. It can tell a call's push from a message's, and so when a phone is rung. A push's collapse ID, which the relay and Apple see in the clear, is different for each phone, so it doesn't show who received the same message.

## What stops abuse

Anyone holding a handle can ask for a push, so limits follow the phone: pushes are limited for each device token, however many handles someone makes for it, and a call rings a phone only a few times a minute. A push over the limit is dropped but answered as if it were sent, since a refusal would show a server that another server's handle names the same phone.

Nothing one caller does holds up anyone else's pushes or registrations, so it doesn't matter who else shares their address, as every server behind one of Cloudflare's does. Registrations are limited per address, counting an IPv6 /56 as one, and a phone can bring only so many VoIP tokens, which Apple can't check without ringing. A token Apple says doesn't exist is remembered for a day, in memory, and pushes to it are answered without asking Apple, so that naming made-up phones costs Apple one request each. An address gets five of those checked, then one an hour, counting those still waiting on Apple. At most 256 pushes wait on Apple at once, and apart from them 32 registrations, so that a flood of registrations from many addresses never holds up a push.

## What it needs

- **An APNs key** from the Apple Developer account that publishes the app: Certificates, IDs & Profiles → Keys → **+** → Apple Push Notifications service (APNs). Set its environment to **Sandbox & Production** and its restriction to **Team Scoped (All Topics)**, as the relay uses one key for both environments: debug builds use the sandbox, and TestFlight and App Store builds production. Download the `.p8` file (Apple offers it only once) and note its Key ID. As it starts, the relay asks Apple whether it takes the key in each environment and logs the answer, which `deploy/update.sh` shows. Apple answers `403 InvalidProviderToken` alike to a Key ID that isn't the key's, a key from another team and one that was revoked, so check them all.
- **A domain** for the relay, such as `push.example.com`, with HTTPS.
- **A machine with Docker.** The relay needs very little memory and CPU.

## Running it

**Without Docker,** on Linux with systemd, `deploy/install-relay.sh` sets up the relay alone, for your own reverse proxy to put HTTPS in front. It asks for the relay's domain, the `.p8` file, whose Key ID it takes from its name when Apple's is kept, the address to listen on, where the proxy reaches it, and the proxy's address, the only one it takes callers' addresses from, and installs nothing else:

```bash
sudo /opt/zuna/deploy/install-relay.sh
```

Update it later with `sudo zuna-update`. `deploy/update.sh` does the same with options, alone or next to a chat server. See [LINUX.md](LINUX.md):

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
| `ZUNA_PUSH_APNS_KEY` | | The `.p8` file. Without it, phones can't register, and pushes fail |
| `ZUNA_PUSH_APNS_KEY_ID` | | The key's ID |
| `ZUNA_PUSH_APNS_TEAM` | `SGKB9R23YT` | The team that publishes the app |
| `ZUNA_PUSH_APNS_TOPIC` | `chat.zuna.mobile` | The app's bundle ID |
| `ZUNA_PUSH_LISTEN` | `127.0.0.1:8090` (`:8090` in Docker) | Where to listen, behind the proxy that adds HTTPS |
| `ZUNA_PUSH_DATA` | `./zuna-push-data` (`/data` in Docker) | Holds `handle.key` |
| `ZUNA_PUSH_TRUST_PROXY` | `false` | Take callers' addresses from the proxy's `X-Forwarded-For`, for rate limits, when it's on this machine or a private network |
| `ZUNA_PUSH_TRUSTED_PROXIES` | | Comma-separated addresses or CIDR ranges of the proxies to trust, instead of those networks. Cloudflare's never count |
| `ZUNA_PUSH_BEHIND_CLOUDFLARE` | `false` | Behind Cloudflare's proxy, take a request from it to be from whoever it names in `CF-Connecting-IP`, as the server does ([Behind Cloudflare](SELF_HOSTING.md#behind-cloudflare)). `deploy/install-relay.sh` sets it when the domain is behind Cloudflare |

**Back up `handle.key`.** Every handle is sealed with it. If it's lost, servers forget the handles they hold the next time they push, and notifications stop until each app registers again, which it does when it's opened once its handles are a week old.

## Pointing servers and the app at it

- **The project's relay** runs at `https://relay.mgalazka.pl`.
- **Servers** list the relays that may wake their members' phones in `ZUNA_PUSH_RELAYS`. By default that's the project's relay, so self-hosters get notifications without setting anything. `off` turns them off.
- **The app** registers with the relay in its `ZUNA_PUSH_RELAY` build setting (`apps/ios/project.yml`), the project's relay. Debug builds use Apple's sandbox, and TestFlight and App Store builds use production. The relay handles both with one key.

## The notification filtering entitlement

Muted chats shouldn't notify, but an extension can hide a notification only with Apple's notification filtering entitlement (`com.apple.developer.usernotifications.filtering`). Until Apple grants it, the app tells each server which chats are muted, and until when for a chat muted for a while, and the server skips them until then. Mentions in muted chats then don't notify. Groups set to notify only about mentions aren't sent at all, since the server can't tell which messages mention someone, so until then they notify about everything on the phone. For the same reason channels, which only notify about what mentions or answers someone, aren't pushed to the phone at all: it's told about them only while the app runs.

The Account Holder applies at developer.apple.com/contact/request/notification-filtering. A description along these lines fits:

> Zuna is an end-to-end encrypted messenger. Our servers can't read messages, so a push only says that a message arrived, and our Notification Service Extension fetches and decrypts it on the device. Whether to show it depends on things only the device knows, such as chats the person muted or set to notify only about mentions (unless the message mentions them), messages deleted before the push arrived, and messages the person already read on another device. Without filtering, we would have to tell our servers which chats each person muted.

Once it's granted, add the entitlement to `ZunaNotifications` in `apps/ios/project.yml` and set `PushStore.canFilter` to `true`. The extension then drops what shouldn't show, and the app stops sending muted chats to servers. It tells them it filters instead (`filters`), and they push it channels' messages too.
