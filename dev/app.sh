#!/usr/bin/env bash
# Opens a development version of the app, with live reload.
cd "$(dirname "$0")/.." || exit 1
. scripts/lib.sh
exec node scripts/dev-app.mjs "$@"
