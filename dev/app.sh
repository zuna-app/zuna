#!/usr/bin/env bash
# Builds and opens a development build of the native app: under Wayland on Linux, or as
# "Zuna Dev" on macOS.
cd "$(dirname "$0")/.." || exit 1
. scripts/lib.sh
if [ "$(uname)" = Darwin ]; then
  exec npm run dev:macos -- "$@"
fi
exec npm run dev:linux -- "$@"
