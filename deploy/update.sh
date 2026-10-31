#!/usr/bin/env bash
# Installs or updates Zuna on a Linux machine with systemd, built from this git
# checkout: the chat server, the push relay (docs/PUSH_RELAY.md), or both, with
# Caddy in front for HTTPS. Run it again to update: it pulls, builds, installs
# and restarts, and goes back to the previous build if the new one doesn't start.
# See docs/LINUX.md.
#
# The first time, say what runs here:
#
#   sudo deploy/update.sh --server chat.example.com
#   sudo deploy/update.sh --server chat.example.com --relay push.example.com \
#     --apns-key AuthKey_ABC123DEFG.p8 --apns-key-id ABC123DEFG
#
# After that, to update:
#
#   sudo deploy/update.sh
#
# Options:
#   --server DOMAIN      run the chat server at DOMAIN
#   --relay DOMAIN       run the push relay at DOMAIN
#   --apns-key FILE      the relay's APNs key (.p8), kept in /etc/zuna/apns.p8
#   --apns-key-id ID     that key's ID
#   --push-relays URLS   the relays the server sends notifications through,
#                        comma-separated (default: the relay on this machine)
#   --no-pull            build what's checked out, without pulling
#   --test               run the server's tests before installing
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
CONF=/etc/zuna/update.conf
SERVER_PORT=8080
RELAY_PORT=8090

fail() {
  echo "Error: $*" >&2
  exit 1
}

step() {
  echo
  echo "==> $*"
}

# --- Options, and what an earlier run set up ---

SERVER_DOMAIN=""
RELAY_DOMAIN=""
PUSH_RELAYS=""
APNS_KEY_ID=""
# shellcheck source=/dev/null
if [ -r "$CONF" ]; then . "$CONF"; fi

APNS_KEY_FILE=""
PULL=1
TEST=0
SERVER_CHANGED=0
RELAY_CHANGED=0
RELAYS_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_DOMAIN="${2:?--server needs a domain}"; SERVER_CHANGED=1; shift 2 ;;
    --relay) RELAY_DOMAIN="${2:?--relay needs a domain}"; RELAY_CHANGED=1; shift 2 ;;
    --apns-key) APNS_KEY_FILE="${2:?--apns-key needs a file}"; RELAY_CHANGED=1; shift 2 ;;
    --apns-key-id) APNS_KEY_ID="${2:?--apns-key-id needs an ID}"; RELAY_CHANGED=1; shift 2 ;;
    --push-relays) PUSH_RELAYS="${2:?--push-relays needs a list}"; RELAYS_GIVEN=1; SERVER_CHANGED=1; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    --test) TEST=1; shift ;;
    -h | --help) sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run this with sudo."
command -v systemctl >/dev/null || fail "this needs systemd."
[ -d "$SRC/.git" ] || fail "$SRC isn't a git checkout of Zuna."
[ -n "$SERVER_DOMAIN$RELAY_DOMAIN" ] || fail "nothing to run yet. Say what runs here the first time, for example: --server chat.example.com"
if [ -n "$APNS_KEY_FILE" ] && [ ! -r "$APNS_KEY_FILE" ]; then fail "can't read $APNS_KEY_FILE"; fi
# The server sends notifications through the relay on this machine, unless told otherwise.
if [ "$RELAYS_GIVEN" = 0 ] && [ -z "$PUSH_RELAYS" ] && [ -n "$RELAY_DOMAIN" ]; then
  PUSH_RELAYS="https://$RELAY_DOMAIN"
  SERVER_CHANGED=1
fi

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

# The checkout's owner pulls and builds, so the checkout stays theirs.
OWNER="$(stat -c %U "$SRC")"
OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
as_owner() {
  if [ "$OWNER" = root ]; then
    "$@"
  else
    runuser -u "$OWNER" -- env HOME="$OWNER_HOME" PATH="$PATH" "$@"
  fi
}

# --- Tools: git, curl, Go and Caddy ---

install_packages() {
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" >/dev/null
  elif command -v dnf >/dev/null; then
    dnf install -y -q "$@" >/dev/null
  else
    fail "install $* yourself; this script knows apt and dnf."
  fi
}

step "Checking the tools"
missing=()
for tool in git curl tar; do command -v "$tool" >/dev/null || missing+=("$tool"); done
if [ ${#missing[@]} -gt 0 ]; then
  if command -v apt-get >/dev/null; then apt-get update -q >/dev/null; fi
  install_packages "${missing[@]}" ca-certificates
fi

export PATH="/usr/local/go/bin:$PATH"
# Any Go from 1.21 on fetches the version go.mod asks for by itself.
go_minor() { go env GOVERSION 2>/dev/null | sed -n 's/^go1\.\([0-9]*\).*/\1/p'; }
if ! command -v go >/dev/null || [ "$(go_minor)" -lt 21 ] 2>/dev/null || [ -z "$(go_minor)" ]; then
  version="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n1)"
  file="$version.linux-$ARCH.tar.gz"
  echo "Installing Go ($version) in /usr/local/go"
  tmp="$(mktemp -d)"
  curl -fsSL "https://dl.google.com/go/$file" -o "$tmp/$file"
  echo "$(curl -fsSL "https://dl.google.com/go/$file.sha256")  $tmp/$file" | sha256sum -c --quiet - || fail "the Go download doesn't match its checksum."
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tmp/$file"
  rm -rf "$tmp"
fi
echo "Go: $(go version)"

if ! command -v caddy >/dev/null; then
  echo "Installing Caddy"
  if command -v apt-get >/dev/null; then
    apt-get update -q >/dev/null
    if ! DEBIAN_FRONTEND=noninteractive apt-get install -y -q caddy >/dev/null 2>&1; then
      # Older releases don't have it: Caddy's own repository does.
      install_packages debian-keyring debian-archive-keyring apt-transport-https gnupg
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
      apt-get update -q >/dev/null
      install_packages caddy
    fi
  else
    install_packages caddy
  fi
fi
echo "Caddy: $(caddy version | head -n1)"

# --- Pull and build ---

if [ "$PULL" = 1 ]; then
  step "Pulling updates"
  as_owner git -C "$SRC" pull --ff-only
fi
VERSION="$(as_owner git -C "$SRC" describe --tags --always --dirty)"

if [ "$TEST" = 1 ]; then
  step "Testing"
  (cd "$SRC/server" && as_owner go test ./...)
fi

step "Building $VERSION"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
chown "$OWNER" "$BUILD"
build() {
  (cd "$SRC/server" && as_owner env CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$BUILD/$1" "./cmd/$1")
  echo "Built $1"
}
if [ -n "$SERVER_DOMAIN" ]; then build zuna-server; fi
if [ -n "$RELAY_DOMAIN" ]; then build zuna-push; fi

# --- Install and configure ---

step "Installing"
install -d -m 0755 /etc/zuna
cat >"$CONF" <<EOF
# What deploy/update.sh set up on this machine. Change it with the script's options.
SERVER_DOMAIN="$SERVER_DOMAIN"
RELAY_DOMAIN="$RELAY_DOMAIN"
PUSH_RELAYS="$PUSH_RELAYS"
APNS_KEY_ID="$APNS_KEY_ID"
EOF

# Keeps the running binary as .previous, so a build that doesn't start can be undone.
install_binary() {
  install -m 0755 "$BUILD/$1" "/usr/local/bin/$1.new"
  if [ -f "/usr/local/bin/$1" ]; then cp -p "/usr/local/bin/$1" "/usr/local/bin/$1.previous"; fi
  mv -f "/usr/local/bin/$1.new" "/usr/local/bin/$1"
}

add_user() {
  id "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --shell /usr/sbin/nologin "$1"
}

FIRST_SERVER=0
if [ -n "$SERVER_DOMAIN" ]; then
  if [ ! -f /etc/systemd/system/zuna.service ]; then FIRST_SERVER=1; fi
  add_user zuna /var/lib/zuna
  install -d -o zuna -g zuna -m 0750 /var/lib/zuna
  install_binary zuna-server
  install -m 0644 "$SRC/deploy/zuna.service" /etc/systemd/system/zuna.service
  # Written the first time and when options change; edits made by hand stay otherwise.
  if [ ! -f /etc/zuna/zuna.env ] || [ "$SERVER_CHANGED" = 1 ]; then
    cat >/etc/zuna/zuna.env <<EOF
# The chat server, behind Caddy, which adds HTTPS. Written by deploy/update.sh.
ZUNA_DATA=/var/lib/zuna
ZUNA_LISTEN=127.0.0.1:$SERVER_PORT
ZUNA_PUBLIC_URL=https://$SERVER_DOMAIN
ZUNA_TRUST_PROXY=true
ZUNA_PUSH_RELAYS=$PUSH_RELAYS
EOF
  fi
fi

if [ -n "$RELAY_DOMAIN" ]; then
  add_user zuna-push /var/lib/zuna-push
  install -d -o zuna-push -g zuna-push -m 0700 /var/lib/zuna-push
  install_binary zuna-push
  install -m 0644 "$SRC/deploy/zuna-push.service" /etc/systemd/system/zuna-push.service
  if [ -n "$APNS_KEY_FILE" ]; then
    install -o root -g zuna-push -m 0640 "$APNS_KEY_FILE" /etc/zuna/apns.p8
  fi
  if [ ! -f /etc/zuna/push.env ] || [ "$RELAY_CHANGED" = 1 ]; then
    {
      echo "# The push relay, behind Caddy, which adds HTTPS. Written by deploy/update.sh."
      echo "ZUNA_PUSH_DATA=/var/lib/zuna-push"
      echo "ZUNA_PUSH_LISTEN=127.0.0.1:$RELAY_PORT"
      echo "ZUNA_PUSH_TRUST_PROXY=true"
      if [ -f /etc/zuna/apns.p8 ]; then
        echo "ZUNA_PUSH_APNS_KEY=/etc/zuna/apns.p8"
        echo "ZUNA_PUSH_APNS_KEY_ID=$APNS_KEY_ID"
      fi
    } >/etc/zuna/push.env
  fi
  if [ ! -f /etc/zuna/apns.p8 ]; then
    echo "No APNs key yet: phones can register, but pushes will fail. Add one with --apns-key and --apns-key-id."
  fi
fi

step "Configuring Caddy"
{
  echo "# Zuna's sites. Written by deploy/update.sh; changes here are overwritten."
  if [ -n "$SERVER_DOMAIN" ]; then printf '%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$SERVER_DOMAIN" "$SERVER_PORT"; fi
  if [ -n "$RELAY_DOMAIN" ]; then printf '%s {\n\treverse_proxy 127.0.0.1:%s\n}\n' "$RELAY_DOMAIN" "$RELAY_PORT"; fi
} >/etc/caddy/zuna.caddy
if grep -q "root \* /usr/share/caddy" /etc/caddy/Caddyfile 2>/dev/null || [ ! -s /etc/caddy/Caddyfile ]; then
  # Caddy's own welcome page answers on port 80; Zuna's sites replace it.
  echo "import /etc/caddy/zuna.caddy" >/etc/caddy/Caddyfile
elif ! grep -q "import /etc/caddy/zuna.caddy" /etc/caddy/Caddyfile; then
  printf '\nimport /etc/caddy/zuna.caddy\n' >>/etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || fail "Caddy doesn't accept /etc/caddy/Caddyfile: check it with caddy validate."
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "Opened ports 80 and 443 in ufw"
fi

# --- Restart, check, and undo if it doesn't come up ---

step "Restarting"
systemctl daemon-reload
systemctl enable --quiet caddy
systemctl reload-or-restart caddy

healthy() {
  for _ in $(seq 1 20); do
    if curl -fs -o /dev/null "http://127.0.0.1:$1/healthz"; then return 0; fi
    sleep 0.5
  done
  return 1
}

restart() {
  local unit="$1" binary="$2" port="$3"
  systemctl enable --quiet "$unit"
  systemctl restart "$unit"
  if healthy "$port"; then
    echo "$unit is running $VERSION"
    return
  fi
  journalctl -u "$unit" --no-pager -n 20 >&2 || true
  if [ -f "/usr/local/bin/$binary.previous" ]; then
    mv -f "/usr/local/bin/$binary.previous" "/usr/local/bin/$binary"
    systemctl restart "$unit"
    fail "$unit didn't start with $VERSION, so the previous build is back."
  fi
  fail "$unit didn't start."
}

if [ -n "$SERVER_DOMAIN" ]; then restart zuna zuna-server "$SERVER_PORT"; fi
if [ -n "$RELAY_DOMAIN" ]; then restart zuna-push zuna-push "$RELAY_PORT"; fi

echo
if [ -n "$SERVER_DOMAIN" ]; then echo "Chat server: https://$SERVER_DOMAIN"; fi
if [ -n "$RELAY_DOMAIN" ]; then echo "Push relay:  https://$RELAY_DOMAIN"; fi
if [ "$FIRST_SERVER" = 1 ]; then
  link="$(journalctl -u zuna --no-pager -n 50 | grep -o "https://[^ ]*/invite/[^ ]*" | tail -n1 || true)"
  echo
  if [ -n "$link" ]; then
    echo "Finish setup: paste this one-time link into the Zuna app. It creates your owner account."
    echo "  $link"
  else
    echo "Find your setup link with: journalctl -u zuna | grep invite"
  fi
fi
