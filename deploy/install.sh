#!/bin/sh
# Installs the Zuna server on a Linux machine with systemd, using automatic HTTPS.
#
#   curl -fsSL https://raw.githubusercontent.com/zuna-chat/zuna/main/deploy/install.sh | sudo sh -s -- chat.example.com
#
# Set ZUNA_REPO to install from a fork. Your domain must already point at this
# machine, with ports 80 and 443 open.
set -eu

REPO="${ZUNA_REPO:-zuna-chat/zuna}"
DOMAIN="${1:-}"

fail() {
  echo "Error: $1" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "please run this with sudo."
[ -n "$DOMAIN" ] || fail "give your domain, for example: sh install.sh chat.example.com"
command -v systemctl >/dev/null || fail "this installer needs systemd. See docs/SELF_HOSTING.md for other options."
command -v curl >/dev/null || fail "curl is required."

case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) fail "unsupported CPU architecture: $(uname -m)" ;;
esac

ASSET="zuna-server-linux-$ARCH"
BASE="https://github.com/$REPO/releases/latest/download"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $ASSET..."
curl -fsSL "$BASE/$ASSET" -o "$TMP/zuna-server"
curl -fsSL "$BASE/SHA256SUMS" -o "$TMP/SHA256SUMS"

echo "Verifying the download..."
EXPECTED="$(grep " $ASSET\$" "$TMP/SHA256SUMS" | cut -d' ' -f1)"
ACTUAL="$(sha256sum "$TMP/zuna-server" | cut -d' ' -f1)"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "the download doesn't match its checksum."

install -m 0755 "$TMP/zuna-server" /usr/local/bin/zuna-server
id zuna >/dev/null 2>&1 || useradd --system --home-dir /var/lib/zuna --shell /usr/sbin/nologin zuna
install -d -o zuna -g zuna -m 0750 /var/lib/zuna
install -d -m 0755 /etc/zuna
cat >/etc/zuna/zuna.env <<EOF
ZUNA_DOMAIN=$DOMAIN
ZUNA_DATA=/var/lib/zuna
EOF

curl -fsSL "https://raw.githubusercontent.com/$REPO/main/deploy/zuna.service" -o /etc/systemd/system/zuna.service
systemctl daemon-reload
systemctl enable --now zuna

echo
echo "Zuna is running. Waiting for your setup link..."
sleep 2
journalctl -u zuna --no-pager -n 20 | grep -A1 -E "Finish setup|/invite/" || \
  echo "Find your setup link with: journalctl -u zuna | grep invite"
