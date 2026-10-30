#!/usr/bin/env bash
# Deletes all development data, for a fresh start.
cd "$(dirname "$0")/.." || exit 1
. scripts/lib.sh
exec node scripts/dev-clean.mjs
