#!/bin/sh
# Sets up a Zuna server on a Linux machine with systemd, in one command: gets git, puts
# Zuna's code in /opt/zuna, and starts its installer, deploy/install.sh, which asks a few
# questions and changes nothing until you say yes. See docs/SELF_HOSTING.md.
#
#   curl -fsSL https://zuna.chat/install.sh | sudo sh
#
# The installer's options follow, as with:
#
#   curl -fsSL https://zuna.chat/install.sh | sudo sh -s -- --channel nightly
#
# To read this first: curl -fsSLO https://zuna.chat/install.sh, then sudo sh install.sh.
#
# All of it is in a function called on the last line, so that a download cut short runs nothing.

set -eu

REPOSITORY=https://github.com/zuna-app/zuna.git
DIR=/opt/zuna

say() { printf '  %s\n' "$*"; }
fail() {
  printf '\n  %s\n\n' "$*" >&2
  exit 1
}
# git as root in a checkout that may be someone else's, which it would otherwise refuse.
in_checkout() { git -c safe.directory="$DIR" -C "$DIR" "$@"; }

main() {
  [ "$(id -u)" = 0 ] || fail "Run this with sudo: curl -fsSL https://zuna.chat/install.sh | sudo sh"
  [ -d /run/systemd/system ] || fail "Zuna's installer needs a Linux machine running systemd."

  if ! command -v git >/dev/null 2>&1; then
    say "Installing git"
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -q >/dev/null
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q git ca-certificates >/dev/null
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q git ca-certificates >/dev/null
    else
      fail "This needs git, and installs it with apt or dnf, which aren't here. Install git, then run this again."
    fi
  fi

  if [ -d "$DIR/.git" ]; then
    say "Zuna's code is in $DIR already. Getting what's new."
    in_checkout fetch --quiet --tags --force origin
  elif [ -e "$DIR" ]; then
    fail "$DIR is there already, and isn't Zuna's code. Move it out of the way, then run this again."
  else
    say "Getting Zuna's code into $DIR"
    git clone --quiet "$REPOSITORY" "$DIR"
  fi

  # A machine with Zuna set up already is the installer's to update, as it asks. A new one
  # starts from the installer of what it'll run: the newest stable release, unless it's
  # asked for nightly, or none is out yet, when it's main's newest commit.
  if [ ! -r /etc/zuna/update.conf ]; then
    channel=stable previous=""
    for arg in "$@"; do
      [ "$previous" = --channel ] && channel="$arg"
      previous="$arg"
    done
    tag="$(in_checkout tag --list 'v*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
    if [ "$channel" = stable ] && [ -n "$tag" ]; then
      in_checkout checkout --quiet --detach "$tag"
    else
      if ! in_checkout symbolic-ref -q HEAD >/dev/null; then
        branch="$(in_checkout symbolic-ref --short refs/remotes/origin/HEAD)"
        in_checkout checkout --quiet "${branch#origin/}"
      fi
      in_checkout pull --quiet --ff-only
    fi
  fi

  # The installer asks its questions on the terminal, not on this pipe.
  if (exec </dev/tty) 2>/dev/null; then
    exec "$DIR/deploy/install.sh" "$@" </dev/tty
  fi
  exec "$DIR/deploy/install.sh" "$@"
}

main "$@"
