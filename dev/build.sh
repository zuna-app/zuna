#!/usr/bin/env bash
# Builds what Zuna ships for Linux. Run dev/setup.sh once first.
#
#   dev/build.sh           the app and the server
#   dev/build.sh app       the native app as a .deb, an .rpm, a pacman package, an
#                          AppImage and a .tar.gz, in dist/linux/packages
#   dev/build.sh server    the server for every platform, in dist/server
#
# Set ZUNA_VERSION to stamp a version into the server, as releases do.
cd "$(dirname "$0")/.." || exit 1
. scripts/lib.sh
set -eu

what=${1:-all}
case $what in
  all | app | server) ;;
  *)
    echo "Usage: dev/build.sh [app|server]" >&2
    exit 2
    ;;
esac

if [ "$what" != server ]; then
  if [ ! -d node_modules ] || ! command -v wasm-bindgen >/dev/null 2>&1; then
    echo "Run dev/setup.sh first." >&2
    exit 1
  fi
  npm run build:crypto
  npm run dist:linux
fi
if [ "$what" != app ]; then
  npm run build:server
fi

echo
echo "Built:"
if [ "$what" != server ]; then
  ls -1 dist/linux/packages/*
fi
if [ "$what" != app ]; then
  ls -1 dist/server/zuna-server-*
fi
