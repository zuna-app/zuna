#!/bin/sh
# Builds LiveKit's server, the media server for voice channels and calls, from the commit in
# ./version with Zuna's patch (./zuna.patch), which keeps what it learns about the people who
# join out of its log and gives apps no outside STUN servers ("Voice channels" in docs/SECURITY_DETAILS.md).
#
#   deploy/livekit/build.sh [--test] <output>
#
# --test also runs the patch's own test. It needs git and Go 1.21 or newer, which fetches the
# Go that ./version names by itself, and the network, for LiveKit and its modules. Go's caches
# stay where Go keeps them, in the home folder of whoever runs this. Options for go build, such
# as -p 1 on a small machine, go in GOFLAGS. scripts/lib.mjs does the same in Node, for
# development on every system: change both together.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
test=0
if [ "${1:-}" = --test ]; then
  test=1
  shift
fi
[ $# -eq 1 ] || { echo "usage: $0 [--test] <output>" >&2; exit 2; }
case "$1" in
  /*) output="$1" ;;
  *) output="$(pwd)/$1" ;;
esac

read -r tag commit toolchain <"$here/version"
patch="$here/zuna.patch"
stamp="$(sha256sum "$patch" | cut -c1-12)"
# LiveKit's go.mod names no toolchain, so a Go older than the one it asks for would fetch the
# first release of that, without its fixes.
export GOTOOLCHAIN="$toolchain+auto" CGO_ENABLED=0

work="$(mktemp -d)"
trap 'chmod -R u+w "$work" 2>/dev/null; rm -rf "$work"' EXIT
cd "$work"

# That commit and no other, as a tag can be moved.
git init --quiet
git fetch --quiet --depth 1 https://github.com/livekit/livekit "$commit"
git -c advice.detachedHead=false checkout --quiet FETCH_HEAD
[ "$(git rev-parse HEAD)" = "$commit" ] || { echo "fetched $(git rev-parse HEAD), not $commit" >&2; exit 1; }

# The patch reaches into LiveKit's protocol module, so a copy of it from Go's module cache,
# where go.sum has checked it, takes its place.
go mod download github.com/livekit/protocol
cp -R "$(go list -m -f '{{.Dir}}' github.com/livekit/protocol)" zuna-protocol
chmod -R u+w zuna-protocol
go mod edit -replace github.com/livekit/protocol=./zuna-protocol

git -c core.autocrlf=false apply --whitespace=nowarn "$patch"
# What shows the patch reached what it was for.
reached() { grep -q "$2" "$1" || { echo "$patch didn't reach $1 in LiveKit $tag" >&2; exit 1; }; }
reached zuna-protocol/logger/zaputil/zaputil.go 'enc zunaEncoder'
reached zuna-protocol/logger/zaputil/zaputil.go 'zunaCore{zapcore.NewCore'
reached zuna-protocol/logger/zaputil/zuna.go 'func (e zunaEncoder) EncodeEntry'
reached pkg/service/server.go 'zunaRecovery(),'
reached cmd/server/main.go '"-zuna." + zunaPatch'
reached pkg/service/roommanager.go 'Zuna: apps are given no outside STUN servers'
# A logger of LiveKit's own that writes past the encoder, which these would make.
if grep -rnE --include='*.go' '\.(WithTee|ToZap|FromZapLogger)\(' pkg cmd | grep -v '_test\.go:'; then
  echo "LiveKit $tag logs past Zuna's filter in the lines above" >&2
  exit 1
fi

if [ "$test" = 1 ]; then
  go test -count=1 -run Zuna ./cmd/server
fi
go build -buildvcs=false -trimpath -ldflags "-s -w -buildid= -X main.zunaPatch=$stamp" -o "$output" ./cmd/server
version="$("$output" --version)"
case "$version" in
  *"${tag#v}-zuna.$stamp") echo "Built LiveKit ${tag#v}-zuna.$stamp" ;;
  *) echo "the build says it's \"$version\"" >&2; exit 1 ;;
esac
