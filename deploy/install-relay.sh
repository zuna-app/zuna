#!/usr/bin/env bash
# Sets up the push relay alone (docs/PUSH_RELAY.md) on a Linux machine with
# systemd, through deploy/update.sh, with a few questions: its domain, the APNs
# key, the address it listens on, for a reverse proxy that adds HTTPS, and the
# proxy's. It installs no chat server, proxy or certificate: those are yours.
#
#   sudo /opt/zuna/deploy/install-relay.sh
#
# Update later with:  sudo zuna-update
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8090

fail() {
  echo "Error: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "run this with sudo."
{ exec 3</dev/tty; } 2>/dev/null || fail "this asks questions, so it needs a terminal."

# Asks until CHECK accepts the answer, taking DEFAULT on Enter. Sets ANSWER.
ask() {
  local prompt="$1" default="$2" check="$3"
  while :; do
    if [ -n "$default" ]; then printf '%s [%s] ' "$prompt" "$default"; else printf '%s ' "$prompt"; fi
    IFS= read -r -u 3 ANSWER || fail "no answer, so nothing was changed."
    ANSWER="${ANSWER:-$default}"
    if [ -n "$ANSWER" ] && "$check" "$ANSWER"; then return; fi
  done
}

check_domain() {
  [[ "${1,,}" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$ ]] && return 0
  echo "That isn't a domain, such as push.example.com."
  return 1
}
check_key() {
  if [ -r "$1" ] && grep -q 'BEGIN PRIVATE KEY' "$1"; then return 0; fi
  echo "That isn't a .p8 key this machine can read."
  return 1
}
check_key_id() {
  [[ "$1" =~ ^[A-Z0-9]{10}$ ]] && return 0
  echo "A Key ID is 10 letters and digits, such as ABC123DEFG."
  return 1
}
is_ipv4() {
  local part
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for part in ${1//./ }; do [ "$part" -le 255 ] || return 1; done
}
is_ipv6() { [[ "$1" == *:* ]] && [[ "$1" =~ ^[0-9a-fA-F:]+$ ]]; }
check_ip() {
  if is_ipv4 "$1" || is_ipv6 "$1"; then return 0; fi
  echo "That isn't an IP address, such as 10.0.0.2."
  return 1
}
# One of this machine's addresses, or every address.
check_address() {
  case "$1" in 0.0.0.0 | ::) return 0 ;; esac
  if ip -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | grep -qxF "$1"; then return 0; fi
  echo "That isn't one of this machine's addresses."
  return 1
}
# An address and port, as a URL writes them: an IPv6 address goes in brackets.
address() {
  case "$1" in
    *:*) echo "[$1]:$2" ;;
    *) echo "$1:$2" ;;
  esac
}

is_private() {
  case "$1" in
    10.* | 127.* | 192.168.* | 169.254.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
    [fF][cCdD]*:* | [fF][eE][89abAB]*:* | ::1) return 0 ;;
  esac
  return 1
}

# A machine that has the relay already only needs updating, and one with a chat
# server is update.sh's to change.
if [ -r /etc/zuna/update.conf ]; then
  server="$(sed -n 's/^SERVER_DOMAIN="\(.*\)"$/\1/p' /etc/zuna/update.conf)"
  relay="$(sed -n 's/^RELAY_DOMAIN="\(.*\)"$/\1/p' /etc/zuna/update.conf)"
  if [ -n "$server" ]; then
    fail "this machine runs a chat server, at $server. Add the relay to it with: sudo zuna-update --relay push.example.com --apns-key AuthKey_….p8 --apns-key-id …"
  fi
  if [ -n "$relay" ]; then
    printf 'The relay is set up here already, at %s. Update it? [Y/n] ' "$relay"
    IFS= read -r -u 3 reply || exit 1
    case "${reply:-y}" in [Yy]*) exec "$SRC/deploy/update.sh" ;; *) exit 0 ;; esac
  fi
fi

echo "This sets up Zuna's push relay here, and nothing else."
echo
ask "The relay's domain:" "" check_domain
DOMAIN="${ANSWER,,}"
# Behind Cloudflare, a request from it is from whoever it names, for the relay's limits.
CLOUDFLARE=off
if curl -sI --max-time 5 "http://$DOMAIN/" 2>/dev/null | tr -d '\r' | grep -qi -e '^cf-ray:' -e '^server: cloudflare'; then
  echo "$DOMAIN is behind Cloudflare."
  CLOUDFLARE=on
fi
ask "The APNs key, a .p8 file:" "" check_key
KEY="$ANSWER"
# Apple names the file after the key: AuthKey_ABC123DEFG.p8.
KEY_ID="$(basename "$KEY" | sed -n 's/^AuthKey_\([A-Z0-9]\{10\}\)\.p8$/\1/p')"
if [ -n "$KEY_ID" ]; then
  echo "Its Key ID, from its name: $KEY_ID"
else
  ask "Its Key ID:" "" check_key_id
  KEY_ID="$ANSWER"
fi
echo
echo "This machine's addresses:"
ip -o addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print "  " a[1] "  (" $2 ")" }'
first="$(ip -o -4 addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }')"
ask "The address to listen on, where the proxy reaches the relay:" "$first" check_address
LISTEN="$ANSWER"
# Only the proxy can say who's calling, for the relay's limits: anyone else who
# reaches the relay is taken to be calling from where they are.
case "$LISTEN" in
  127.* | ::1) PROXY="127.0.0.1,::1" ;;
  *)
    ask "The proxy's address, which it reaches the relay from:" "" check_ip
    PROXY="$ANSWER"
    ;;
esac
while ss -Hltn "sport = :$PORT" 2>/dev/null | grep -q . && ! ss -Hltnp "sport = :$PORT" 2>/dev/null | grep -q '"zuna-push"'; do PORT=$((PORT + 1)); done
RELAY_AT="$(address "$LISTEN" "$PORT")"

echo
echo "Ready to set up:"
echo "  Relay      https://$DOMAIN, through your proxy, to http://$RELAY_AT"
echo "  Proxy      $PROXY, the only one that can say who's calling"
echo "  APNs key   $KEY, Key ID $KEY_ID, kept in /etc/zuna/apns.p8"
echo "  Update     sudo zuna-update"
printf 'Set it up? [Y/n] '
IFS= read -r -u 3 reply || exit 1
case "${reply:-y}" in [Yy]*) ;; *) echo "Nothing was changed."; exit 0 ;; esac

"$SRC/deploy/update.sh" --relay "$DOMAIN" --apns-key "$KEY" --apns-key-id "$KEY_ID" --listen "$LISTEN" --relay-port "$PORT" --trusted-proxies "$PROXY" --behind-cloudflare "$CLOUDFLARE"

echo
echo "Your proxy has to reach http://$RELAY_AT. If a firewall is on here, let it through to"
echo "port $PORT/tcp, and nothing else."
echo
if ! is_private "$LISTEN"; then
  echo "Warning: the relay speaks plain HTTP on $LISTEN, an address the internet reaches. Let only the"
  echo "proxy reach port $PORT, and keep what's between them private."
  echo
fi
echo "Chat servers send pushes through it once their ZUNA_PUSH_RELAYS lists https://$DOMAIN,"
echo "and phones register with it when their app is built with that address (docs/PUSH_RELAY.md)."
