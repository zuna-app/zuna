#!/usr/bin/env bash
# Gets a Linux machine ready to work on Zuna. Checks for the tools in
# CONTRIBUTING.md and installs missing ones with the package manager where it
# can, installs the matching wasm-bindgen, then installs the npm packages and
# builds the encryption core. Safe to run again, for example after pulling.
cd "$(dirname "$0")/.." || exit 1
. scripts/lib.sh
set -eu

if command -v pacman >/dev/null 2>&1; then
  pm=pacman install="sudo pacman -S --needed"
elif command -v dnf >/dev/null 2>&1; then
  pm=dnf install="sudo dnf install"
elif command -v apt-get >/dev/null 2>&1; then
  pm=apt install="sudo apt-get install"
else
  pm=none install=""
fi

packages=""
by_hand=""

# missing <pacman packages> <dnf packages> <apt packages> <what to get by hand>
# Debian and Ubuntu ship Node and Go too old for Zuna, so those come from upstream.
missing() {
  case $pm in
    pacman) pkgs=$1 ;;
    dnf) pkgs=$2 ;;
    apt) pkgs=$3 ;;
    *) pkgs="" ;;
  esac
  if [ -n "$pkgs" ]; then
    packages="$packages $pkgs"
  else
    by_hand="$by_hand
  - $4"
  fi
}

# at_least <version> <minimum>
at_least() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

node_version=$(node -p process.versions.node 2>/dev/null || true)
if [ -z "$node_version" ]; then
  missing "nodejs npm" "nodejs npm" "" "Node 22.22 or newer: https://nodejs.org/en/download"
elif ! at_least "$node_version" 22.22; then
  by_hand="$by_hand
  - Node 22.22 or newer, you have $node_version: https://nodejs.org/en/download"
fi

go_version=$(go env GOVERSION 2>/dev/null | sed 's/^go//; s/[^0-9.].*//')
if [ -z "$go_version" ]; then
  missing go golang "" "Go 1.25 or newer: https://go.dev/dl"
elif ! at_least "$go_version" 1.25; then
  by_hand="$by_hand
  - Go 1.25 or newer, you have $go_version: https://go.dev/dl"
fi

# Rust links its build scripts with the system C compiler.
command -v cc >/dev/null 2>&1 || missing gcc gcc build-essential "a C compiler, such as gcc"

# With rustup the WebAssembly target is added below. Rust from the package
# manager has it in a separate package.
if ! command -v cargo >/dev/null 2>&1; then
  missing "rust rust-wasm" "cargo rust-std-static-wasm32-unknown-unknown" "" "Rust: https://rustup.rs"
elif ! command -v rustup >/dev/null 2>&1 && [ ! -d "$(rustc --print sysroot)/lib/rustlib/wasm32-unknown-unknown" ]; then
  missing rust-wasm rust-std-static-wasm32-unknown-unknown libstd-rust-dev-wasm32 \
    "the wasm32-unknown-unknown target for your Rust, or Rust from https://rustup.rs"
fi

if [ -n "$by_hand" ]; then
  echo "Please install:$by_hand"
fi
if [ -n "$packages" ]; then
  echo "Missing packages:$packages"
  # Installs only once, so a package that doesn't help can't make this loop.
  if [ -z "$by_hand" ] && [ -t 0 ] && [ -z "${ZUNA_SETUP_INSTALLED:-}" ]; then
    echo "> $install$packages"
    $install$packages
    ZUNA_SETUP_INSTALLED=1 exec dev/setup.sh "$@"
  fi
  echo "Install them with:"
  echo "  $install$packages"
fi
if [ -n "$by_hand$packages" ]; then
  echo "Then run dev/setup.sh again."
  exit 1
fi

if command -v rustup >/dev/null 2>&1; then
  echo "> rustup target add wasm32-unknown-unknown"
  rustup target add wasm32-unknown-unknown
fi

# wasm-bindgen has to be exactly the version the crate is built against.
wasm_bindgen=$(grep -A1 '^name = "wasm-bindgen"$' crypto/Cargo.lock | sed -n 's/^version = "\(.*\)"$/\1/p')
if [ "$(wasm-bindgen --version 2>/dev/null || true)" != "wasm-bindgen $wasm_bindgen" ]; then
  echo "> cargo install wasm-bindgen-cli --locked --version $wasm_bindgen"
  cargo install wasm-bindgen-cli --locked --version "$wasm_bindgen"
fi

# Exactly what the lockfile says, without rewriting it for this npm version.
echo "> npm ci"
npm ci
npm run build:crypto

cat <<'EOF'

  Ready. From here:
    dev/server.sh    Opens a test server that's ready to use
    dev/app.sh       Opens a development version of the app
    dev/clean.sh     Deletes all development data, for a fresh start
    dev/build.sh     Builds the AppImage, the .deb and the server binaries
EOF
