#!/usr/bin/env bash
# Installs or updates Zuna on a Linux machine with systemd, built from this git
# checkout: the chat server, with LiveKit for voice channels if you like, the push
# relay (docs/PUSH_RELAY.md), the web app (docs/WEB.md), or any of them together.
# They speak plain HTTP, for a reverse proxy, here or on another machine, to put
# HTTPS in front. Run it again to update: it pulls, builds, installs and restarts,
# and goes back to the previous build if the new one doesn't start. See
# docs/LINUX.md.
#
# deploy/install.sh asks about the chat server and its proxy and runs this. Or,
# the first time, say what runs here:
#
#   sudo deploy/update.sh --server chat.example.com
#   sudo deploy/update.sh --server 203.0.113.7 --voice on
#   sudo deploy/update.sh --server chat.example.com --relay push.example.com \
#     --apns-key AuthKey_ABC123DEFG.p8 --apns-key-id ABC123DEFG
#   sudo deploy/update.sh --server chat.example.com --web web.chat.example.com
#   sudo deploy/update.sh --server chat.example.com --voice on
#
# After that, to update, which runs this script:
#
#   sudo zuna-update
#
# Options:
#   --server DOMAIN      run the chat server at DOMAIN, or at this machine's IP
#                        address instead, where it serves HTTPS itself, with a
#                        certificate of its own, on --server-port on every address
#                        (docs/SELF_HOSTING.md#without-a-domain)
#   --voice on|off       run LiveKit, the media server for voice channels, next to
#                        the server (default off). Apps reach it through the server
#   --voice-ip ADDRESS   the address calls' media reaches this machine at, which
#                        LiveKit gives apps (default: the server's IP address, or
#                        else the public one LiveKit asks a STUN server for)
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
#   --database-url URL   keep the server's data in PostgreSQL, at an address such
#                        as postgres://zuna:password@localhost/zuna, which is kept
#                        only in /etc/zuna/zuna.env, or "" for SQLite again
#                        (default: SQLite, in /var/lib/zuna)
#   --listen ADDRESS     where the proxy reaches them (default 127.0.0.1, for a
#                        proxy on this machine; this machine's private address,
#                        or 0.0.0.0 for every address, for a proxy on another)
#   --trusted-proxies L  the proxies to believe about who's calling, as addresses
#                        or CIDR ranges, comma-separated (default: this machine
#                        and private networks). Cloudflare's never count
#   --behind-cloudflare on|off  whether the domains here are behind Cloudflare's
#                        proxy, which then says who's calling (default off)
#   --server-port PORT   the server's port (default 9660)
#   --relay-port PORT    the relay's port (default 8090)
#   --web-port PORT      the web app's port (default 8081)
#   --voice-port PORT    LiveKit's own port, which only the server reaches
#                        (default 7880)
#   --voice-tcp-port PORT  where calls' media arrives over TCP (default 7881)
#   --voice-udp-port PORT  where calls' media arrives over UDP (default 7882)
#   --signed-tags        only ever build the newest release tag, if its signature
#                        checks out. This happens by itself, once there's a tag
#                        signed by a key this machine trusts
#   --follow-branch      build the branch's newest commit, whatever tags there are
#   --allow-user-checkout  run even though someone other than root can change this
#                        checkout, and so what this script does as root
#   --no-pull            build what's checked out, without pulling
#   --test               run the server's tests, and the test of LiveKit's patch
#                        when it's built, before installing
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
BEHIND_CLOUDFLARE=off
SIGNED_TAGS=0
ALLOW_USER_CHECKOUT=0
SERVER_PORT=9660
RELAY_PORT=8090
WEB_PORT=8081
VOICE=off
VOICE_IP=""
VOICE_PORT=7880
VOICE_TCP_PORT=7881
VOICE_UDP_PORT=7882
# shellcheck source=/dev/null
if [ -r "$CONF" ]; then . "$CONF"; fi

APNS_KEY_FILE=""
PULL=1
TEST=0
SERVER_CHANGED=0
RELAY_CHANGED=0
WEB_CHANGED=0
VOICE_CHANGED=0
RELAYS_GIVEN=0
WEB_SERVER_GIVEN=0
DATABASE_URL=""
DATABASE_URL_GIVEN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER_DOMAIN="${2:?--server needs a domain}"; SERVER_CHANGED=1; VOICE_CHANGED=1; shift 2 ;;
    --relay) RELAY_DOMAIN="${2:?--relay needs a domain}"; RELAY_CHANGED=1; shift 2 ;;
    --web) WEB_DOMAIN="${2:?--web needs a domain}"; WEB_CHANGED=1; shift 2 ;;
    --web-server) WEB_SERVER="${2:?--web-server needs an address}"; WEB_SERVER_GIVEN=1; WEB_CHANGED=1; shift 2 ;;
    --web-servers) WEB_SERVERS="${2:?--web-servers needs a list, or any}"; [ "$WEB_SERVERS" = any ] && WEB_SERVERS=""; WEB_CHANGED=1; shift 2 ;;
    --web-previews) WEB_PREVIEWS="${2:?--web-previews needs on or off}"; WEB_CHANGED=1; shift 2 ;;
    --apns-key) APNS_KEY_FILE="${2:?--apns-key needs a file}"; RELAY_CHANGED=1; shift 2 ;;
    --apns-key-id) APNS_KEY_ID="${2:?--apns-key-id needs an ID}"; RELAY_CHANGED=1; shift 2 ;;
    --push-relays) PUSH_RELAYS="${2:?--push-relays needs a list}"; RELAYS_GIVEN=1; SERVER_CHANGED=1; shift 2 ;;
    --database-url) DATABASE_URL="${2?--database-url needs an address}"; DATABASE_URL_GIVEN=1; SERVER_CHANGED=1; shift 2 ;;
    --listen) LISTEN="${2:?--listen needs an address}"; SERVER_CHANGED=1; RELAY_CHANGED=1; WEB_CHANGED=1; shift 2 ;;
    --trusted-proxies) TRUSTED_PROXIES="${2:?--trusted-proxies needs a list}"; SERVER_CHANGED=1; RELAY_CHANGED=1; WEB_CHANGED=1; shift 2 ;;
    --behind-cloudflare) BEHIND_CLOUDFLARE="${2:?--behind-cloudflare needs on or off}"; SERVER_CHANGED=1; RELAY_CHANGED=1; WEB_CHANGED=1; shift 2 ;;
    --server-port) SERVER_PORT="${2:?--server-port needs a port}"; SERVER_CHANGED=1; shift 2 ;;
    --relay-port) RELAY_PORT="${2:?--relay-port needs a port}"; RELAY_CHANGED=1; shift 2 ;;
    --web-port) WEB_PORT="${2:?--web-port needs a port}"; WEB_CHANGED=1; shift 2 ;;
    --voice) VOICE="${2:?--voice needs on or off}"; VOICE_CHANGED=1; SERVER_CHANGED=1; shift 2 ;;
    --voice-ip) VOICE_IP="${2?--voice-ip needs an address}"; VOICE_CHANGED=1; shift 2 ;;
    --voice-port) VOICE_PORT="${2:?--voice-port needs a port}"; VOICE_CHANGED=1; SERVER_CHANGED=1; shift 2 ;;
    --voice-tcp-port) VOICE_TCP_PORT="${2:?--voice-tcp-port needs a port}"; VOICE_CHANGED=1; shift 2 ;;
    --voice-udp-port) VOICE_UDP_PORT="${2:?--voice-udp-port needs a port}"; VOICE_CHANGED=1; shift 2 ;;
    --signed-tags) SIGNED_TAGS=1; shift ;;
    --follow-branch) SIGNED_TAGS=branch; shift ;;
    --allow-user-checkout) ALLOW_USER_CHECKOUT=1; shift ;;
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
case "$APNS_KEY_FILE" in "" | /*) ;; *) APNS_KEY_FILE="$PWD/$APNS_KEY_FILE" ;; esac
# Building runs as another user, who may not be able to enter the folder this was
# started in, such as a home folder, and GNU find stops there. So everything runs
# from /, and the rest of this script names its folders in full.
START_DIR="$PWD"
cd /
# Without a domain, the server is reached at an IP address and serves HTTPS itself,
# with no proxy, so on a port it may use without any power, on every address.
SERVER_IP=""
if [[ "$SERVER_DOMAIN" =~ ^[0-9.]+$ ]] || [[ "$SERVER_DOMAIN" == *:* ]]; then
  SERVER_IP="${SERVER_DOMAIN#[}"
  SERVER_IP="${SERVER_IP%]}"
  [ "$SERVER_PORT" -ge 1024 ] || fail "without a domain, the server needs a --server-port from 1024 up, as it runs without the power to use lower ones."
fi
# LiveKit gives apps the server's address for calls' media, as that's where they reach this machine.
LIVEKIT_IP="${VOICE_IP:-$SERVER_IP}"
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
  # Its sign-in form starts with the server on this machine, unless told otherwise, or
  # the server has no domain, which a browser can't reach.
  if [ "$WEB_SERVER_GIVEN" = 0 ] && [ -z "$WEB_SERVER" ] && [ -n "$SERVER_DOMAIN" ] && [ -z "$SERVER_IP" ]; then
    WEB_SERVER="https://$SERVER_DOMAIN"
    WEB_CHANGED=1
  fi
fi
case "$VOICE" in on | off) ;; *) fail "--voice is on or off" ;; esac
case "$BEHIND_CLOUDFLARE" in on | off) ;; *) fail "--behind-cloudflare is on or off" ;; esac
CLOUDFLARE_ENV=false
if [ "$BEHIND_CLOUDFLARE" = on ]; then CLOUDFLARE_ENV=true; fi
# The server hands apps' signaling on to LiveKit, so LiveKit runs next to it.
if [ "$VOICE" = on ] && [ -z "$SERVER_DOMAIN" ]; then
  fail "voice channels run next to the chat server, so this machine needs --server too."
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
# This script runs as root, from this checkout, so whoever can change it is root at
# the next update. An edit may already have removed this check, so what this is for
# is getting a machine out of that position before anyone has.
if [ "$ALLOW_USER_CHECKOUT" != 1 ]; then
  if [ "$OWNER" != root ] || [ -n "$(find "$SRC/deploy/update.sh" "$SRC/.git" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
    fail "someone other than root can change $SRC, and through it what this script does as root. Fix that with: sudo chown -R root:root $SRC && sudo chmod -R go-w $SRC. Or, if that's how you want it, run this with --allow-user-checkout."
  fi
fi
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
  # package.json asks for Node 22.22 or newer.
  node_ok() { node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 22) ? 0 : 1)' 2>/dev/null; }
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
# Building the web app needs Rust and Node on the PATH.
as_web_builder() {
  runuser -u "$BUILDER" -- env HOME="$BUILDER_HOME" PATH="$CARGO_BIN:$PATH" "$@"
}

# --- Pull and build ---

if [ "$PULL" = 1 ]; then
  step "Pulling updates"
  before="$(sha256sum "$SRC/deploy/update.sh")"
  if [ "$SIGNED_TAGS" != branch ]; then
    as_owner git -C "$SRC" fetch --tags --force
    tag="$(as_owner git -C "$SRC" tag --list 'v*' --sort=-v:refname | head -n1)"
    # The first signature that checks out here is what every update after it has to
    # have, so taking over the repository can't simply go back to not signing.
    if [ "$SIGNED_TAGS" != 1 ] && [ -n "$tag" ] && as_owner git -C "$SRC" verify-tag "$tag" >/dev/null 2>&1; then
      echo "Release tags here are signed by a key this machine trusts, so from now on only those are installed."
      SIGNED_TAGS=1
      ARGS+=(--signed-tags)
    fi
  fi
  if [ "$SIGNED_TAGS" = 1 ]; then
    # Nothing is built or run until its signature checks out. See docs/LINUX.md.
    [ -n "$tag" ] || fail "there's no release tag to update to."
    as_owner git -C "$SRC" verify-tag "$tag" || fail "the signature of $tag doesn't check out, so nothing was changed."
    as_owner git -C "$SRC" checkout --quiet --detach "$tag"
    echo "Verified $tag"
  else
    if [ "$SIGNED_TAGS" != branch ]; then
      echo "Warning: no release tag here is signed by a key this machine trusts, so this is building"
      echo "the branch's newest commit, with nothing to say who wrote it. See docs/LINUX.md."
    fi
    # Going back to the branch, after building a tag left no branch checked out.
    if ! as_owner git -C "$SRC" symbolic-ref -q HEAD >/dev/null; then
      branch="$(as_owner git -C "$SRC" symbolic-ref --short refs/remotes/origin/HEAD)"
      as_owner git -C "$SRC" checkout --quiet "${branch#origin/}"
    fi
    as_owner git -C "$SRC" pull --ff-only
  fi
  # A newer version of this script finishes the job.
  if [ "$(sha256sum "$SRC/deploy/update.sh")" != "$before" ]; then
    echo "This script changed; running the new version"
    # From where this one started, where any files its options name are.
    cd "$START_DIR"
    exec "$SRC/deploy/update.sh" "${ARGS[@]}" --no-pull
  fi
fi
VERSION="$(as_owner git -C "$SRC" describe --tags --always --dirty)"

# LiveKit is built from the commit in deploy/livekit/version with Zuna's patch, which keeps
# what it learns about the people who join out of its log (deploy/livekit/build.sh), and again
# only when the commit or the patch changes, which its --version says.
read -r LIVEKIT_TAG _ _ <"$SRC/deploy/livekit/version"
LIVEKIT_VERSION="${LIVEKIT_TAG#v}-zuna.$(sha256sum "$SRC/deploy/livekit/zuna.patch" | cut -c1-12)"
LIVEKIT_NEW=0
LIVEKIT_GOFLAGS=""
if [ "$VOICE" = on ] && [ "$(/usr/local/bin/livekit-server --version 2>/dev/null | awk '{print $NF}')" != "$LIVEKIT_VERSION" ]; then
  LIVEKIT_NEW=1
  # Built one package at a time, it takes up to 830 MB at once, its linker most of it, which
  # was measured on 2026-11-12. With less free, it stops here, before anything has changed.
  free_mb="$(awk '/^(MemAvailable|SwapFree):/ { kb += $2 } END { print int(kb / 1024) }' /proc/meminfo)"
  if [ "$free_mb" -lt 900 ]; then
    fail "building LiveKit takes about 900 MB of memory, and this machine has $free_mb MB free, swap included. Add swap, or free some, and run this again. Nothing was changed."
  fi
  if [ "$free_mb" -lt 3000 ]; then LIVEKIT_GOFLAGS="-p=1"; fi
fi

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
# As the build account, like the rest, into $BUILD. --test runs the patch's own test too.
build_livekit() {
  local test=""
  if [ "$TEST" = 1 ]; then test=--test; fi
  as_builder env GOFLAGS="$LIVEKIT_GOFLAGS" GOMEMLIMIT=500MiB sh "$SRC/deploy/livekit/build.sh" $test "$BUILD/livekit-server"
}
if [ -n "$SERVER_DOMAIN" ]; then build zuna-server; fi
if [ -n "$RELAY_DOMAIN" ]; then build zuna-push; fi
if [ -n "$WEB_DOMAIN" ]; then build_web; fi
if [ "$LIVEKIT_NEW" = 1 ]; then build_livekit; fi

# --- Install and configure ---

step "Installing"
install -d -m 0755 /etc/zuna
# Each value is quoted for the shell, which reads this file back as root, and the file
# is moved into place whole.
{
  echo "# What deploy/update.sh set up on this machine. Change it with the script's options."
  for name in SERVER_DOMAIN RELAY_DOMAIN WEB_DOMAIN WEB_SERVER WEB_SERVERS WEB_PREVIEWS \
    PUSH_RELAYS APNS_KEY_ID LISTEN TRUSTED_PROXIES BEHIND_CLOUDFLARE SIGNED_TAGS \
    ALLOW_USER_CHECKOUT SERVER_PORT RELAY_PORT WEB_PORT VOICE VOICE_IP VOICE_PORT \
    VOICE_TCP_PORT VOICE_UDP_PORT; do
    printf '%s=%q\n' "$name" "${!name}"
  done
} >"$CONF.new"
mv -f "$CONF.new" "$CONF"

# sudo zuna-update runs this script, wherever this checkout is.
cat >/usr/local/sbin/zuna-update.new <<EOF
#!/bin/sh
# Updates Zuna on this machine. Written by deploy/update.sh.
exec "$SRC/deploy/update.sh" "\$@"
EOF
chmod 0755 /usr/local/sbin/zuna-update.new
mv -f /usr/local/sbin/zuna-update.new /usr/local/sbin/zuna-update

# Keeps the running binary as .previous, so a build that doesn't start can be undone.
install_binary() {
  install -m 0755 "${2:-$BUILD/$1}" "/usr/local/bin/$1.new"
  if [ -f "/usr/local/bin/$1" ]; then cp -p "/usr/local/bin/$1" "/usr/local/bin/$1.previous"; fi
  mv -f "/usr/local/bin/$1.new" "/usr/local/bin/$1"
}

add_user() {
  id "$1" >/dev/null 2>&1 || useradd --system --home-dir "$2" --shell /usr/sbin/nologin "$1"
}

# LiveKit restarts only when it or its settings change, since that ends every call.
VOICE_RESTART=0
if [ "$VOICE" = on ]; then
  add_user zuna-livekit /nonexistent
  if [ "$LIVEKIT_NEW" = 1 ]; then
    install_binary livekit-server
    VOICE_RESTART=1
  fi
  if ! cmp -s "$SRC/deploy/zuna-livekit.service" /etc/systemd/system/zuna-livekit.service; then
    install -m 0644 "$SRC/deploy/zuna-livekit.service" /etc/systemd/system/zuna-livekit.service
    VOICE_RESTART=1
  fi
  # The key and secret the server signs apps' tokens with, made once. LiveKit
  # refuses a key file that everyone can read.
  if [ ! -f /etc/zuna/livekit-keys.yaml ]; then
    install -o root -g zuna-livekit -m 0640 /dev/null /etc/zuna/livekit-keys.yaml
    echo "zuna: $(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" >/etc/zuna/livekit-keys.yaml
    SERVER_CHANGED=1
    VOICE_RESTART=1
  fi
  if [ ! -f /etc/zuna/livekit.yaml ] || [ "$VOICE_CHANGED" = 1 ]; then
    # Where apps send calls' media: the address given, or else the public one a STUN
    # server sees, which apps on this machine's own network may not reach.
    if [ -n "$LIVEKIT_IP" ]; then
      media_address="  use_external_ip: false
  node_ip: $LIVEKIT_IP"
    else
      media_address="  use_external_ip: true"
    fi
    cat >/etc/zuna/livekit.yaml <<EOF
# LiveKit, the media server for voice channels. Written by deploy/update.sh.
# Only the server on this machine reaches it here, and hands apps' signaling on.
port: $VOICE_PORT
bind_addresses:
  - 127.0.0.1
# Calls' media comes straight here, from anywhere, so these are open in the firewall.
rtc:
  tcp_port: $VOICE_TCP_PORT
  udp_port: $VOICE_UDP_PORT
$media_address
  packet_buffer_size_video: 4096
key_file: /etc/zuna/livekit-keys.yaml
EOF
    VOICE_RESTART=1
  fi
  # How many of a video's packets LiveKit keeps to send again to someone who lost one: its own 500
  # is under a third of a second of a share at 15 Mbit/s, less than asking again takes. Added to a
  # config written before it. The same as LIVEKIT_CONFIG in scripts/lib.mjs.
  if ! grep -q 'packet_buffer_size_video' /etc/zuna/livekit.yaml; then
    sed -i 's/^rtc:$/rtc:\n  packet_buffer_size_video: 4096/' /etc/zuna/livekit.yaml
    VOICE_RESTART=1
  fi
  # LiveKit's codecs, with H.264's Baseline profile as well, which Chromium on macOS encodes on the
  # GPU. Added to a config written before it, keeping whatever was changed there by hand. The same as
  # LIVEKIT_CONFIG in scripts/lib.mjs.
  if ! grep -q '^room:' /etc/zuna/livekit.yaml; then
    cat >>/etc/zuna/livekit.yaml <<EOF
room:
  enabled_codecs:
    - mime: audio/opus
    - mime: audio/red
    - mime: audio/pcmu
    - mime: audio/pcma
    - mime: video/vp8
    - mime: video/h264
    - mime: video/h264
      fmtp_line: level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
    - mime: video/vp9
    - mime: video/av1
    - mime: video/h265
    - mime: video/rtx
EOF
    VOICE_RESTART=1
  fi
fi

FIRST_SERVER=0
if [ -n "$SERVER_DOMAIN" ]; then
  if [ ! -f /etc/systemd/system/zuna.service ]; then FIRST_SERVER=1; fi
  add_user zuna /var/lib/zuna
  install -d -o zuna -g zuna -m 0750 /var/lib/zuna
  install_binary zuna-server
  install -m 0644 "$SRC/deploy/zuna.service" /etc/systemd/system/zuna.service
  # Written the first time and when options change; edits made by hand stay otherwise.
  if [ ! -f /etc/zuna/zuna.env ] || [ "$SERVER_CHANGED" = 1 ]; then
    # The database's address can hold a password, so it's only ever in this file,
    # and goes on to the new one. Without it, the server would start out empty.
    if [ "$DATABASE_URL_GIVEN" = 0 ] && [ -f /etc/zuna/zuna.env ]; then
      DATABASE_URL="$(sed -n 's/^ZUNA_DATABASE_URL=//p' /etc/zuna/zuna.env | tail -n 1)"
    fi
    # Only root reads it, since it can hold LiveKit's secret. systemd reads it before
    # it starts the server. It's written beside the old one and moved into place whole,
    # since a file cut short, without ZUNA_DATABASE_URL, would start the server empty.
    install -m 0600 /dev/null /etc/zuna/zuna.env.new
    if [ -n "$SERVER_IP" ]; then
      cat >>/etc/zuna/zuna.env.new <<EOF
# The chat server, at this machine's IP address, with HTTPS and a certificate of its
# own, whose key is certificate.key in ZUNA_DATA. Written by deploy/update.sh.
ZUNA_DATA=/var/lib/zuna
ZUNA_DOMAIN=$SERVER_DOMAIN
ZUNA_LISTEN=:$SERVER_PORT
EOF
    else
      cat >>/etc/zuna/zuna.env.new <<EOF
# The chat server, behind a reverse proxy that adds HTTPS. Written by deploy/update.sh.
ZUNA_DATA=/var/lib/zuna
ZUNA_LISTEN=$(address "$LISTEN" "$SERVER_PORT")
ZUNA_PUBLIC_URL=https://$SERVER_DOMAIN
# Believes X-Forwarded-For from this machine and private networks, or else from these proxies.
ZUNA_TRUST_PROXY=true
ZUNA_TRUSTED_PROXIES=$TRUSTED_PROXIES
# Behind Cloudflare, a request from it is from whoever it names in CF-Connecting-IP.
ZUNA_BEHIND_CLOUDFLARE=$CLOUDFLARE_ENV
EOF
    fi
    cat >>/etc/zuna/zuna.env.new <<EOF
# Empty is the project's relay, and "off" is none.
ZUNA_PUSH_RELAYS=$PUSH_RELAYS
# PostgreSQL, or empty for SQLite in ZUNA_DATA.
ZUNA_DATABASE_URL=$DATABASE_URL
EOF
    if [ "$VOICE" = on ]; then
      cat >>/etc/zuna/zuna.env.new <<EOF
# Voice channels, through LiveKit on this machine. Apps reach it through this server, at /livekit/.
ZUNA_LIVEKIT_INTERNAL_URL=http://$(address 127.0.0.1 "$VOICE_PORT")
ZUNA_LIVEKIT_KEY=zuna
ZUNA_LIVEKIT_SECRET=$(sed -n 's/^zuna: *//p' /etc/zuna/livekit-keys.yaml)
EOF
    fi
    mv -f /etc/zuna/zuna.env.new /etc/zuna/zuna.env
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
      echo "ZUNA_PUSH_BEHIND_CLOUDFLARE=$CLOUDFLARE_ENV"
      if [ -f /etc/zuna/apns.p8 ]; then
        echo "ZUNA_PUSH_APNS_KEY=/etc/zuna/apns.p8"
        echo "ZUNA_PUSH_APNS_KEY_ID=$APNS_KEY_ID"
      fi
    } >/etc/zuna/push.env.new
    mv -f /etc/zuna/push.env.new /etc/zuna/push.env
  fi
  if [ ! -f /etc/zuna/apns.p8 ]; then
    echo "No APNs key yet: phones can't register, and pushes fail. Add one with --apns-key and --apns-key-id."
  fi
fi

if [ -n "$WEB_DOMAIN" ]; then
  install_binary zuna-web
  install -m 0644 "$SRC/deploy/zuna-web.service" /etc/systemd/system/zuna-web.service
  if [ ! -f /etc/zuna/zuna-web.env ] || [ "$WEB_CHANGED" = 1 ]; then
    cat >/etc/zuna/zuna-web.env.new <<EOF
# The web app, behind a reverse proxy that adds HTTPS. Written by deploy/update.sh.
ZUNA_WEB_LISTEN=$(address "$LISTEN" "$WEB_PORT")
ZUNA_WEB_TRUST_PROXY=true
ZUNA_WEB_TRUSTED_PROXIES=$TRUSTED_PROXIES
ZUNA_WEB_BEHIND_CLOUDFLARE=$CLOUDFLARE_ENV
ZUNA_WEB_SERVER=$WEB_SERVER
# Empty lets the app connect to any server.
ZUNA_WEB_SERVERS=$WEB_SERVERS
ZUNA_WEB_PREVIEWS=$WEB_PREVIEWS
EOF
    mv -f /etc/zuna/zuna-web.env.new /etc/zuna/zuna-web.env
  fi
fi

# --- Restart, check, and undo if it doesn't come up ---

step "Restarting"
systemctl daemon-reload

# Whether a service answers at an address, such as http://127.0.0.1:9660/healthz, or
# with HTTPS, whatever its certificate. LiveKit can take a few seconds to find this
# machine's public address.
healthy() {
  for _ in $(seq 1 60); do
    if curl -fsk -o /dev/null "$1"; then return 0; fi
    sleep 0.5
  done
  return 1
}

# Restarts a unit, or with "start" only starts it if it isn't running, and checks it
# answers. If it doesn't, and its binary was installed just now, the previous one goes back.
restart() {
  local unit="$1" binary="$2" url="$3" running="${4:-$VERSION}" action="${5:-restart}"
  systemctl enable --quiet "$unit"
  systemctl "$action" "$unit"
  if healthy "$url"; then
    echo "$unit is running $running"
    return
  fi
  journalctl -u "$unit" --no-pager -n 20 >&2 || true
  if [ -n "$binary" ] && [ -f "/usr/local/bin/$binary.previous" ]; then
    mv -f "/usr/local/bin/$binary.previous" "/usr/local/bin/$binary"
    systemctl restart "$unit"
    fail "$unit didn't start with $running, so the previous build is back."
  fi
  fail "$unit didn't start."
}

# Shows what Apple said about the relay's APNs key, which the relay asks before it listens.
apns_answer() {
  local invocation lines=""
  invocation="$(systemctl show -p InvocationID --value zuna-push)"
  for _ in $(seq 1 10); do
    lines="$(journalctl _SYSTEMD_INVOCATION_ID="$invocation" --no-pager -o cat 2>/dev/null | grep "the APNs key" | sed 's/^[0-9/]* [0-9:]* //' || true)"
    if [[ "$lines" == *environment=production* && "$lines" == *environment=sandbox* ]]; then break; fi
    sleep 0.5
  done
  if [ -z "$lines" ]; then return; fi
  printf '%s\n' "$lines" | sed 's/^/  /'
  if [[ "$lines" == *"Apple refuses"* ]]; then
    echo "Phones can't register until Apple takes the key. Give the relay the right one, with its Key ID:"
    echo "  sudo zuna-update --apns-key AuthKey_ABC123DEFG.p8 --apns-key-id ABC123DEFG"
  fi
}

if [ "$VOICE" = on ]; then
  if [ "$VOICE_RESTART" = 1 ]; then action=restart; else action=start; fi
  if [ "$LIVEKIT_NEW" = 1 ]; then binary=livekit-server; else binary=""; fi
  restart zuna-livekit "$binary" "http://$(address 127.0.0.1 "$VOICE_PORT")/" "LiveKit $LIVEKIT_VERSION" "$action"
elif [ -f /etc/systemd/system/zuna-livekit.service ]; then
  systemctl disable --now --quiet zuna-livekit
  if [ "$VOICE_CHANGED" = 1 ]; then echo "zuna-livekit is stopped, so voice channels can't be joined"; fi
fi
if [ -n "$SERVER_IP" ]; then
  restart zuna zuna-server "https://$(address 127.0.0.1 "$SERVER_PORT")/healthz"
elif [ -n "$SERVER_DOMAIN" ]; then
  restart zuna zuna-server "http://$(local_address "$SERVER_PORT")/healthz"
fi
if [ -n "$RELAY_DOMAIN" ]; then
  restart zuna-push zuna-push "http://$(local_address "$RELAY_PORT")/healthz"
  if [ -f /etc/zuna/apns.p8 ]; then apns_answer; fi
fi
if [ -n "$WEB_DOMAIN" ]; then restart zuna-web zuna-web "http://$(local_address "$WEB_PORT")/healthz"; fi

echo
# Where a proxy on another machine finds them: this machine's address, when they listen on all of them.
HOST="$LISTEN"
case "$LISTEN" in
  0.0.0.0 | ::) HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"; HOST="${HOST:-this-machine}" ;;
esac
if [ -n "$SERVER_IP" ]; then
  echo "People reach the server at https://$(address "$SERVER_IP" "$SERVER_PORT"), with a certificate of its"
  echo "own, so open ${SERVER_PORT}/tcp to them. Back up /var/lib/zuna/certificate.key: a new one would"
  echo "need new links for everyone (docs/SELF_HOSTING.md#without-a-domain)."
fi
if [ -n "$RELAY_DOMAIN$WEB_DOMAIN" ] || { [ -n "$SERVER_DOMAIN" ] && [ -z "$SERVER_IP" ]; }; then
  echo "Point your reverse proxy at them, with HTTPS and WebSockets (see docs/LINUX.md):"
  if [ -n "$SERVER_DOMAIN" ] && [ -z "$SERVER_IP" ]; then echo "  https://$SERVER_DOMAIN -> http://$(address "$HOST" "$SERVER_PORT")"; fi
  if [ -n "$RELAY_DOMAIN" ]; then echo "  https://$RELAY_DOMAIN -> http://$(address "$HOST" "$RELAY_PORT")"; fi
  if [ -n "$WEB_DOMAIN" ]; then echo "  https://$WEB_DOMAIN -> http://$(address "$HOST" "$WEB_PORT")"; fi
fi
if [ "$VOICE" = on ]; then
  echo
  echo "Voice channels' signaling goes through the server's address, at /livekit/. Their media"
  echo "doesn't: open ${VOICE_TCP_PORT}/tcp and ${VOICE_UDP_PORT}/udp to everyone, straight to this machine."
fi
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
echo
echo "Update later with: sudo zuna-update"
