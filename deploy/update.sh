#!/usr/bin/env bash
# Installs or updates Zuna on a Linux machine with systemd, built from this git
# checkout: the chat server, the push relay (docs/PUSH_RELAY.md), the web app
# (docs/WEB.md), or any of them together. They speak plain HTTP, for a reverse
# proxy, here or on another machine, to put HTTPS in front. Run it again to
# update: it pulls, builds, installs and restarts, and goes back to the previous
# build if the new one doesn't start. See docs/LINUX.md.
#
# The first time, say what runs here:
#
#   sudo deploy/update.sh --server chat.example.com
#   sudo deploy/update.sh --server chat.example.com --relay push.example.com \
#     --apns-key AuthKey_ABC123DEFG.p8 --apns-key-id ABC123DEFG
#   sudo deploy/update.sh --server chat.example.com --web web.chat.example.com
#
# After that, to update:
#
#   sudo deploy/update.sh
#
# Options:
#   --server DOMAIN      run the chat server at DOMAIN
#   --relay DOMAIN       run the push relay at DOMAIN
#   --web DOMAIN         run the web app at DOMAIN, a domain of its own
#   --web-server URL     the server the web app's sign-in form starts with
#                        (default: the server on this machine)
#   --web-servers URLS   the only servers the web app may connect to,
#                        comma-separated, or "any" (default any)
#   --web-previews on|off  whether the web app's host fetches pages for link
#                        previews (default on)
#   --apns-key FILE      the relay's APNs key (.p8), kept in /etc/zuna/apns.p8
#   --apns-key-id ID     that key's ID
#   --push-relays URLS   the relays the server sends notifications through,
#                        comma-separated, or "off" (default: the relay on this
#                        machine, or else the project's)
#   --listen ADDRESS     where the proxy reaches them (default 127.0.0.1, for a
#                        proxy on this machine; this machine's private address,
#                        or 0.0.0.0 for every address, for a proxy on another)
#   --trusted-proxies L  the proxies to believe about who's calling, as addresses
#                        or CIDR ranges, comma-separated (default: this machine
#                        and private networks)
#   --server-port PORT   the server's port (default 8080)
#   --relay-port PORT    the relay's port (default 8090)
#   --web-port PORT      the web app's port (default 8081)
#   --signed-tags        build the newest release tag, only if its signature
#                        checks out, instead of the branch's newest commit
#   --no-pull            build what's checked out, without pulling
#   --test               run the server's tests before installing
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
ARGS=("$@")
CONF=/etc/zuna/update.conf

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
WEB_DOMAIN=""
WEB_SERVER=""
WEB_SERVERS=""
WEB_PREVIEWS=on
PUSH_RELAYS=""
APNS_KEY_ID=""
LISTEN=127.0.0.1
TRUSTED_PROXIES=""
SIGNED_TAGS=0
SERVER_PORT=8080
RELAY_PORT=8090
WEB_PORT=8081
# shellcheck source=/dev/null
if [ -r "$CONF" ]; then . "$CONF"; fi

APNS_KEY_FILE=""
PULL=1
TEST=0
SERVER_CHANGED=0
RELAY_CHANGED=0
WEB_CHANGED=0
RELAYS_GIVEN=0
WEB_SERVER_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_DOMAIN="${2:?--server needs a domain}"; SERVER_CHANGED=1; shift 2 ;;
    --relay) RELAY_DOMAIN="${2:?--relay needs a domain}"; RELAY_CHANGED=1; shift 2 ;;
    --web) WEB_DOMAIN="${2:?--web needs a domain}"; WEB_CHANGED=1; shift 2 ;;
    --web-server) WEB_SERVER="${2:?--web-server needs an address}"; WEB_SERVER_GIVEN=1; WEB_CHANGED=1; shift 2 ;;
    --web-servers) WEB_SERVERS="${2:?--web-servers needs a list, or any}"; [ "$WEB_SERVERS" = any ] && WEB_SERVERS=""; WEB_CHANGED=1; shift 2 ;;
    --web-previews) WEB_PREVIEWS="${2:?--web-previews needs on or off}"; WEB_CHANGED=1; shift 2 ;;
    --apns-key) APNS_KEY_FILE="${2:?--apns-key needs a file}"; RELAY_CHANGED=1; shift 2 ;;
    --apns-key-id) APNS_KEY_ID="${2:?--apns-key-id needs an ID}"; RELAY_CHANGED=1; shift 2 ;;
    --push-relays) PUSH_RELAYS="${2:?--push-relays needs a list}"; RELAYS_GIVEN=1; SERVER_CHANGED=1; shift 2 ;;
    --listen) LISTEN="${2:?--listen needs an address}"; SERVER_CHANGED=1; RELAY_CHANGED=1; WEB_CHANGED=1; shift 2 ;;
    --trusted-proxies) TRUSTED_PROXIES="${2:?--trusted-proxies needs a list}"; SERVER_CHANGED=1; RELAY_CHANGED=1; WEB_CHANGED=1; shift 2 ;;
    --server-port) SERVER_PORT="${2:?--server-port needs a port}"; SERVER_CHANGED=1; shift 2 ;;
    --relay-port) RELAY_PORT="${2:?--relay-port needs a port}"; RELAY_CHANGED=1; shift 2 ;;
    --web-port) WEB_PORT="${2:?--web-port needs a port}"; WEB_CHANGED=1; shift 2 ;;
    --signed-tags) SIGNED_TAGS=1; shift ;;
    --no-pull) PULL=0; shift ;;
    --test) TEST=1; shift ;;
    -h | --help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

[ "$(id -u)" = 0 ] || fail "run this with sudo."
command -v systemctl >/dev/null || fail "this needs systemd."
[ -d "$SRC/.git" ] || fail "$SRC isn't a git checkout of Zuna."
[ -n "$SERVER_DOMAIN$RELAY_DOMAIN$WEB_DOMAIN" ] || fail "nothing to run yet. Say what runs here the first time, for example: --server chat.example.com"
if [ -n "$APNS_KEY_FILE" ] && [ ! -r "$APNS_KEY_FILE" ]; then fail "can't read $APNS_KEY_FILE"; fi
# The server sends notifications through the relay on this machine, unless told otherwise.
if [ "$RELAYS_GIVEN" = 0 ] && [ -z "$PUSH_RELAYS" ] && [ -n "$RELAY_DOMAIN" ]; then
  PUSH_RELAYS="https://$RELAY_DOMAIN"
  SERVER_CHANGED=1
fi
if [ -n "$WEB_DOMAIN" ]; then
  # Browsers share storage within an address, so the chat server's pages could reach the web app's.
  if [ "$WEB_DOMAIN" = "$SERVER_DOMAIN" ] || [ "$WEB_DOMAIN" = "$RELAY_DOMAIN" ]; then
    fail "the web app needs a domain of its own, such as web.$WEB_DOMAIN (docs/WEB.md)."
  fi
  case "$WEB_PREVIEWS" in on | off) ;; *) fail "--web-previews is on or off" ;; esac
  # Its sign-in form starts with the server on this machine, unless told otherwise.
  if [ "$WEB_SERVER_GIVEN" = 0 ] && [ -z "$WEB_SERVER" ] && [ -n "$SERVER_DOMAIN" ]; then
    WEB_SERVER="https://$SERVER_DOMAIN"
    WEB_CHANGED=1
  fi
fi
case "$LISTEN" in
  0.0.0.0 | ::)
    echo "Warning: listening on every address, with plain HTTP. Anyone who can reach this machine"
    echo "can reach the services directly and read what passes between them and your proxy, so let"
    echo "only the proxy reach these ports, and keep it on a private network (docs/LINUX.md)."
    ;;
esac

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
# Building runs code from the repository, and from what it depends on, so it
# never runs as root. A checkout owned by root is built by a user just for that.
BUILDER="$OWNER"
BUILDER_HOME="$OWNER_HOME"
if [ "$OWNER" = root ]; then
  BUILDER=zuna-build
  BUILDER_HOME=/var/cache/zuna-build
  id "$BUILDER" >/dev/null 2>&1 || useradd --system --home-dir "$BUILDER_HOME" --shell /usr/sbin/nologin "$BUILDER"
  install -d -o "$BUILDER" -g "$BUILDER" -m 0750 "$BUILDER_HOME"
fi
as_builder() {
  runuser -u "$BUILDER" -- env HOME="$BUILDER_HOME" PATH="$PATH" "$@"
}

# An address and port, as Go and curl write them.
address() {
  case "$1" in
    *:*) echo "[$1]:$2" ;;
    *) echo "$1:$2" ;;
  esac
}
# Where this machine checks that a service answers.
local_address() {
  case "$LISTEN" in
    0.0.0.0 | ::) address 127.0.0.1 "$1" ;;
    *) address "$LISTEN" "$1" ;;
  esac
}

# --- Tools: git, curl and Go ---

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

# The web app is built with Node, and its encryption core with Rust, as WebAssembly.
CARGO_BIN="$BUILDER_HOME/.cargo/bin"
if [ -n "$WEB_DOMAIN" ]; then
  export PATH="/usr/local/node/bin:$PATH"
  # package.json asks for Node 22.5 or newer.
  node_ok() { node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 5) ? 0 : 1)' 2>/dev/null; }
  if ! node_ok; then
    case "$ARCH" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; esac
    base=https://nodejs.org/dist/latest-v24.x
    line="$(curl -fsSL "$base/SHASUMS256.txt" | grep -E -- "  node-v[0-9.]+-linux-$node_arch\.tar\.gz$" || true)"
    [ -n "$line" ] || fail "couldn't find Node for linux-$node_arch."
    file="$(echo "$line" | awk '{print $2}')"
    echo "Installing Node (${file%.tar.gz}) in /usr/local/node"
    tmp="$(mktemp -d)"
    curl -fsSL "$base/$file" -o "$tmp/$file"
    echo "$(echo "$line" | awk '{print $1}')  $tmp/$file" | sha256sum -c --quiet - || fail "the Node download doesn't match its checksum."
    rm -rf /usr/local/node
    install -d -m 0755 /usr/local/node
    tar -C /usr/local/node --strip-components=1 -xzf "$tmp/$file"
    rm -rf "$tmp"
  fi
  echo "Node: $(node --version)"
  # Rust's build scripts run on this machine, so they need its C linker.
  if ! command -v cc >/dev/null; then
    if command -v apt-get >/dev/null; then install_packages build-essential; else install_packages gcc; fi
  fi
  # Rust goes to whoever builds, like Go's caches.
  if [ ! -x "$CARGO_BIN/rustup" ]; then
    case "$ARCH" in amd64) triple=x86_64-unknown-linux-gnu ;; arm64) triple=aarch64-unknown-linux-gnu ;; esac
    url="https://static.rust-lang.org/rustup/dist/$triple/rustup-init"
    echo "Installing Rust for $BUILDER"
    tmp="$(mktemp -d)"
    curl -fsSL "$url" -o "$tmp/rustup-init"
    echo "$(curl -fsSL "$url.sha256" | awk '{print $1}')  $tmp/rustup-init" | sha256sum -c --quiet - || fail "the Rust installer doesn't match its checksum."
    chmod 0755 "$tmp/rustup-init"
    chown -R "$BUILDER" "$tmp"
    as_builder "$tmp/rustup-init" -y -q --profile minimal --default-toolchain stable --no-modify-path
    rm -rf "$tmp"
  fi
  as_builder "$CARGO_BIN/rustup" target add wasm32-unknown-unknown >/dev/null 2>&1
  echo "Rust: $(as_builder "$CARGO_BIN/rustc" --version)"
fi
# Building the web app needs Rust and Node on the PATH, and never Electron's download.
as_web_builder() {
  runuser -u "$BUILDER" -- env HOME="$BUILDER_HOME" PATH="$CARGO_BIN:$PATH" ELECTRON_SKIP_BINARY_DOWNLOAD=1 "$@"
}

# --- Pull and build ---

if [ "$PULL" = 1 ]; then
  step "Pulling updates"
  before="$(sha256sum "$SRC/deploy/update.sh")"
  if [ "$SIGNED_TAGS" = 1 ]; then
    # Nothing is built or run until its signature checks out. See docs/LINUX.md.
    as_owner git -C "$SRC" fetch --tags --force
    tag="$(as_owner git -C "$SRC" tag --list 'v*' --sort=-v:refname | head -n1)"
    [ -n "$tag" ] || fail "there's no release tag to update to."
    as_owner git -C "$SRC" verify-tag "$tag" || fail "the signature of $tag doesn't check out, so nothing was changed."
    as_owner git -C "$SRC" checkout --quiet --detach "$tag"
    echo "Verified $tag"
  else
    as_owner git -C "$SRC" pull --ff-only
  fi
  # A newer version of this script finishes the job.
  if [ "$(sha256sum "$SRC/deploy/update.sh")" != "$before" ]; then
    echo "This script changed; running the new version"
    exec "$SRC/deploy/update.sh" "${ARGS[@]}" --no-pull
  fi
fi
VERSION="$(as_owner git -C "$SRC" describe --tags --always --dirty)"

if [ "$TEST" = 1 ]; then
  step "Testing"
  (cd "$SRC/server" && as_builder go test ./...)
fi

step "Building $VERSION"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
chown "$BUILDER" "$BUILD"
build() {
  # -buildvcs=false: the builder may not own the checkout, which git would refuse to read.
  (cd "$SRC/server" && as_builder env CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$BUILD/$1" "./cmd/$1")
  echo "Built $1"
}
# The web app, which zuna-web carries inside it. Building writes into the tree,
# which the builder may not own, so it builds a copy. Rust's output is kept
# between runs, so the encryption core isn't compiled from nothing every time.
build_web() {
  local web="$BUILDER_HOME/.cache/zuna-web-build"
  # wasm-bindgen has to be exactly the version in crypto/Cargo.lock.
  local bindgen
  bindgen="$(grep -A1 'name = "wasm-bindgen"' "$SRC/crypto/Cargo.lock" | grep version | cut -d'"' -f2)"
  if [ "$(as_web_builder wasm-bindgen --version 2>/dev/null | awk '{print $2}')" != "$bindgen" ]; then
    echo "Installing wasm-bindgen $bindgen for $BUILDER, which takes a few minutes"
    as_web_builder cargo install -q --locked --force wasm-bindgen-cli --version "$bindgen"
  fi
  as_web_builder mkdir -p "$web/crypto"
  as_web_builder find "$web" -mindepth 1 -maxdepth 1 ! -name crypto -exec rm -rf {} +
  as_web_builder find "$web/crypto" -mindepth 1 -maxdepth 1 ! -name target -exec rm -rf {} +
  tar -C "$SRC" --exclude=.git --exclude=node_modules --exclude=target --exclude=dist --exclude=release --exclude=.dev-data -cf - . | as_web_builder tar -C "$web" -xf -
  (cd "$web" && as_web_builder npm ci --no-audit --no-fund --loglevel=error)
  (cd "$web" && as_web_builder node scripts/build-crypto.mjs >/dev/null)
  (cd "$web" && as_web_builder npm run --silent build -w @zuna/web >/dev/null)
  # Only this build's files, whatever the checkout had there.
  as_web_builder rm -rf "$web/server/cmd/zuna-web/site"
  as_web_builder cp -R "$web/apps/web/dist" "$web/server/cmd/zuna-web/site"
  (cd "$web/server" && as_web_builder env CGO_ENABLED=0 go build -buildvcs=false -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$BUILD/zuna-web" ./cmd/zuna-web)
  echo "Built zuna-web, with the web app"
}
if [ -n "$SERVER_DOMAIN" ]; then build zuna-server; fi
if [ -n "$RELAY_DOMAIN" ]; then build zuna-push; fi
if [ -n "$WEB_DOMAIN" ]; then build_web; fi

# --- Install and configure ---

step "Installing"
install -d -m 0755 /etc/zuna
cat >"$CONF" <<EOF
# What deploy/update.sh set up on this machine. Change it with the script's options.
SERVER_DOMAIN="$SERVER_DOMAIN"
RELAY_DOMAIN="$RELAY_DOMAIN"
WEB_DOMAIN="$WEB_DOMAIN"
WEB_SERVER="$WEB_SERVER"
WEB_SERVERS="$WEB_SERVERS"
WEB_PREVIEWS="$WEB_PREVIEWS"
PUSH_RELAYS="$PUSH_RELAYS"
APNS_KEY_ID="$APNS_KEY_ID"
LISTEN="$LISTEN"
TRUSTED_PROXIES="$TRUSTED_PROXIES"
SIGNED_TAGS="$SIGNED_TAGS"
SERVER_PORT="$SERVER_PORT"
RELAY_PORT="$RELAY_PORT"
WEB_PORT="$WEB_PORT"
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
# The chat server, behind a reverse proxy that adds HTTPS. Written by deploy/update.sh.
ZUNA_DATA=/var/lib/zuna
ZUNA_LISTEN=$(address "$LISTEN" "$SERVER_PORT")
ZUNA_PUBLIC_URL=https://$SERVER_DOMAIN
# Believes X-Forwarded-For from this machine and private networks, or else from these proxies.
ZUNA_TRUST_PROXY=true
ZUNA_TRUSTED_PROXIES=$TRUSTED_PROXIES
# Empty is the project's relay, and "off" is none.
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
      echo "# The push relay, behind a reverse proxy that adds HTTPS. Written by deploy/update.sh."
      echo "ZUNA_PUSH_DATA=/var/lib/zuna-push"
      echo "ZUNA_PUSH_LISTEN=$(address "$LISTEN" "$RELAY_PORT")"
      echo "ZUNA_PUSH_TRUST_PROXY=true"
      echo "ZUNA_PUSH_TRUSTED_PROXIES=$TRUSTED_PROXIES"
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

if [ -n "$WEB_DOMAIN" ]; then
  install_binary zuna-web
  install -m 0644 "$SRC/deploy/zuna-web.service" /etc/systemd/system/zuna-web.service
  if [ ! -f /etc/zuna/zuna-web.env ] || [ "$WEB_CHANGED" = 1 ]; then
    cat >/etc/zuna/zuna-web.env <<EOF
# The web app, behind a reverse proxy that adds HTTPS. Written by deploy/update.sh.
ZUNA_WEB_LISTEN=$(address "$LISTEN" "$WEB_PORT")
ZUNA_WEB_TRUST_PROXY=true
ZUNA_WEB_TRUSTED_PROXIES=$TRUSTED_PROXIES
ZUNA_WEB_SERVER=$WEB_SERVER
# Empty lets the app connect to any server.
ZUNA_WEB_SERVERS=$WEB_SERVERS
ZUNA_WEB_PREVIEWS=$WEB_PREVIEWS
EOF
  fi
fi

# --- Restart, check, and undo if it doesn't come up ---

step "Restarting"
systemctl daemon-reload

healthy() {
  for _ in $(seq 1 20); do
    if curl -fs -o /dev/null "http://$(local_address "$1")/healthz"; then return 0; fi
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
if [ -n "$WEB_DOMAIN" ]; then restart zuna-web zuna-web "$WEB_PORT"; fi

echo
# Where a proxy on another machine finds them: this machine's address, when they listen on all of them.
HOST="$LISTEN"
case "$LISTEN" in
  0.0.0.0 | ::) HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"; HOST="${HOST:-this-machine}" ;;
esac
echo "Point your reverse proxy at them, with HTTPS and WebSockets (see docs/LINUX.md):"
if [ -n "$SERVER_DOMAIN" ]; then echo "  https://$SERVER_DOMAIN -> http://$(address "$HOST" "$SERVER_PORT")"; fi
if [ -n "$RELAY_DOMAIN" ]; then echo "  https://$RELAY_DOMAIN -> http://$(address "$HOST" "$RELAY_PORT")"; fi
if [ -n "$WEB_DOMAIN" ]; then echo "  https://$WEB_DOMAIN -> http://$(address "$HOST" "$WEB_PORT")"; fi
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
