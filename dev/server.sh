#!/usr/bin/env bash
# Opens the test server, ready to use. Press Ctrl+C to stop it.
cd "$(dirname "$0")/.." || exit 1
. scripts/lib.sh
exec node scripts/dev-server.mjs "$@"
