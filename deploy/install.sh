#!/usr/bin/env bash
# Sets up a Zuna chat server on a Linux machine with systemd, a question at a
# time: where people reach it, the reverse proxy and certificate in front of it,
# and the firewall. Nothing changes until you confirm the summary. Then it
# installs the server, with LiveKit for voice channels, through deploy/update.sh,
# sets up what you chose, checks that the server answers where people will reach
# it, and shows the one-time link that creates the owner account. See
# docs/SELF_HOSTING.md.
#
#   sudo /opt/zuna/deploy/install.sh
#
# Update later with:  sudo zuna-update
#
# To set up without questions, as from cloud-init, give the answers:
#
#   sudo /opt/zuna/deploy/install.sh --domain chat.example.com --proxy auto --yes
#   sudo /opt/zuna/deploy/install.sh --ip 203.0.113.7 --yes
#
# Options:
#   --domain DOMAIN      people reach the server at DOMAIN, through a reverse proxy
#   --ip ADDRESS         or at this IP address, with no domain or proxy
#   --port PORT          with --ip, the port they reach it on (default 9660)
#   --proxy auto|manual  set up the reverse proxy for you, with Caddy if there's
#                        none yet, or leave it to you and check it afterwards
#   --cert FILE          the certificate the proxy uses, rather than one from
#   --key FILE           Let's Encrypt, and its key
#   --cloudflare MODE    strict, full or flexible: Cloudflare's SSL/TLS mode for
#                        the domain, when it's behind Cloudflare
#   --public-ip ADDRESS  the address calls' media reaches this machine at, when the
#                        domain doesn't point straight at it
#   --database-url URL   keep the server's data in PostgreSQL (docs/SELF_HOSTING.md)
#   --no-firewall        leave the firewall as it is
#   --yes                ask nothing, and take the default for anything not given
#   --dry-run            ask, then show what it would do, without doing it
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/var/log/zuna-install.log
# Where manual proxy settings are saved, for copying.
EXAMPLES=/etc/zuna/proxy
# Where certbot proves the domain is ours, through the proxy on port 80.
ACME_ROOT=/var/www/zuna-acme
# Only tests set these: an ACME server other than Let's Encrypt, and its root.
ACME_CA="${ZUNA_INSTALL_ACME_CA:-}"
ACME_CA_ROOT="${ZUNA_INSTALL_ACME_ROOT:-}"

# What the server trusts by default: this machine and private networks.
LOCAL_PROXIES="127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7,fe80::/10"

# --- Options ---

DOMAIN=""
IP=""
PORT=""
PROXY=""
CERT=""
KEY=""
CLOUDFLARE_MODE=""
CLOUDFLARE_FOUND=0
PUBLIC_IP=""
DATABASE_URL=""
FIREWALL=1
# What was given as an option is asked again only if it doesn't check out.
CERT_GIVEN=0
PUBLIC_IP_GIVEN=0
YES=0
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a domain}"; shift 2 ;;
    --ip) IP="${2:?--ip needs an address}"; shift 2 ;;
    --port) PORT="${2:?--port needs a port}"; shift 2 ;;
    --proxy) PROXY="${2:?--proxy needs auto or manual}"; shift 2 ;;
    --cert) CERT="${2:?--cert needs a file}"; CERT_GIVEN=1; shift 2 ;;
    --key) KEY="${2:?--key needs a file}"; shift 2 ;;
    --cloudflare) CLOUDFLARE_MODE="${2:?--cloudflare needs strict, full or flexible}"; shift 2 ;;
    --public-ip) PUBLIC_IP="${2:?--public-ip needs an address}"; PUBLIC_IP_GIVEN=1; shift 2 ;;
    --database-url) DATABASE_URL="${2:?--database-url needs an address}"; shift 2 ;;
    --no-firewall) FIREWALL=0; shift ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h | --help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option $1 (see --help)" >&2; exit 1 ;;
  esac
done
case "$PROXY" in "" | auto | manual) ;; *) echo "--proxy is auto or manual" >&2; exit 1 ;; esac
case "$CLOUDFLARE_MODE" in "" | strict | full | flexible) ;; *) echo "--cloudflare is strict, full or flexible" >&2; exit 1 ;; esac
if [ -n "$DOMAIN" ] && [ -n "$IP" ]; then echo "Give --domain or --ip, not both" >&2; exit 1; fi
if { [ -n "$CERT" ] && [ -z "$KEY" ]; } || { [ -z "$CERT" ] && [ -n "$KEY" ]; }; then echo "--cert and --key go together" >&2; exit 1; fi

# --- Looks ---

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
  B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' RED=$'\e[31m' GREEN=$'\e[32m' YELLOW=$'\e[33m'
  # Back to the start of the line, and clear it, to draw over a spinner.
  CLEAR=$'\r\e[2K'
  LIVE=1
else
  B="" D="" R="" RED="" GREEN="" YELLOW="" CLEAR=""
  LIVE=0
fi
if [ "$(locale charmap 2>/dev/null)" = UTF-8 ]; then
  OK="✓" BAD="✗" WARN="!" DOT="·" PICK="›" MARK="◆" BAR="│" SPIN=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
else
  OK="+" BAD="x" WARN="!" DOT="-" PICK=">" MARK="*" BAR="|" SPIN=('|' '/' '-' "\\")
fi

say() { printf '  %s\n' "$*"; }
dim() { printf '  %s%s%s\n' "$D" "$*" "$R"; }
good() { printf '  %s%s%s %s\n' "$GREEN" "$OK" "$R" "$*"; }
warn() { printf '  %s%s%s %s\n' "$YELLOW" "$WARN" "$R" "$*"; }
heading() { printf '\n  %s%s%s\n\n' "$B" "$*" "$R"; }
# Lines to read before going on, behind a bar.
alert() {
  local line
  echo
  for line in "$@"; do printf '  %s%s%s %s\n' "$YELLOW" "$BAR" "$R" "$line"; done
  echo
}
fail() {
  printf '\n  %s%s%s %s\n\n' "$RED" "$BAD" "$R" "$*" >&2
  exit 1
}

# The cursor comes back however this ends, what's running stops with it, and an
# early end says what changed.
CHANGING=0
CHILD=""
finish() {
  local status=$?
  [ "$LIVE" = 1 ] && printf '\e[?25h'
  if [ -n "$CHILD" ]; then kill -TERM -- "-$CHILD" 2>/dev/null || kill -TERM "$CHILD" 2>/dev/null || true; fi
  if [ "$status" != 0 ] && [ "$CHANGING" = 1 ]; then
    printf '  %sThis stopped partway. What was done is in %s, and running this again carries on.%s\n\n' "$D" "$LOG" "$R" >&2
  fi
}
trap finish EXIT
trap 'echo; [ "$CHANGING" = 1 ] && exit 130; fail "Stopped. Nothing was changed."' INT TERM

# Answers come from the terminal, even when this script came through a pipe.
if [ "$YES" = 0 ] && ! { exec 3</dev/tty; } 2>/dev/null; then
  fail "This asks questions, so it needs a terminal. To answer them up front instead, see --help."
fi

# Waits for a line of text. Sets REPLY.
answer() {
  IFS= read -r -u 3 REPLY || fail "No answer, so nothing was changed."
}

# Asks for text until CHECK accepts it, taking DEFAULT on Enter. Sets ANSWER.
ask() {
  local prompt="$1" default="${2:-}" check="${3:-}"
  while :; do
    if [ -n "$default" ]; then
      printf '  %s %s[%s]%s ' "$prompt" "$D" "$default" "$R"
    else
      printf '  %s ' "$prompt"
    fi
    answer
    ANSWER="${REPLY:-$default}"
    if [ -n "$ANSWER" ] && { [ -z "$check" ] || "$check" "$ANSWER"; }; then return; fi
  done
}

# Asks yes or no, with DEFAULT, y or n, on Enter.
yes_no() {
  local question="$1" default="$2" hint=y/N
  if [ "$YES" = 1 ]; then
    printf '  %s %s\n' "$question" "$([ "$default" = y ] && echo yes || echo no)"
    [ "$default" = y ]
    return
  fi
  [ "$default" = y ] && hint=Y/n
  while :; do
    printf '  %s %s[%s]%s ' "$question" "$D" "$hint" "$R"
    answer
    case "${REPLY:-$default}" in [Yy]*) return 0 ;; [Nn]*) return 1 ;; esac
  done
}

# Picks one of the options, each "label|what it means", with the arrow keys and
# Enter, or by number. DEFAULT is the one picked at first, from 0. Sets CHOICE.
choose() {
  local selected="$1" i key label width=0
  shift
  local options=("$@") count=$#
  if [ "$YES" = 1 ]; then
    CHOICE=$selected
    printf '  %s %s\n' "$PICK" "${options[selected]%%|*}"
    return
  fi
  for i in "${!options[@]}"; do
    label="${options[i]%%|*}"
    [ ${#label} -gt "$width" ] && width=${#label}
  done
  if [ "$LIVE" = 0 ]; then
    for i in "${!options[@]}"; do
      printf '  %d) %-*s  %s\n' $((i + 1)) "$width" "${options[i]%%|*}" "$(describe "${options[i]}")"
    done
    while :; do
      printf '  Choose 1-%d [%d]: ' "$count" $((selected + 1))
      answer
      if [ -z "$REPLY" ]; then CHOICE=$selected; return; fi
      if [[ "$REPLY" =~ ^[0-9]+$ ]] && [ "$REPLY" -ge 1 ] && [ "$REPLY" -le "$count" ]; then
        CHOICE=$((REPLY - 1))
        return
      fi
    done
  fi
  printf '\e[?25l'
  while :; do
    for i in "${!options[@]}"; do
      label="${options[i]%%|*}"
      if [ "$i" = "$selected" ]; then
        printf '\r\e[2K  %s%s %-*s%s  %s\n' "$B" "$PICK" "$width" "$label" "$R" "$(describe "${options[i]}")"
      else
        printf '\r\e[2K    %s%-*s  %s%s\n' "$D" "$width" "$label" "$(describe "${options[i]}")" "$R"
      fi
    done
    IFS= read -rsn1 -u 3 key || fail "No answer, so nothing was changed."
    case "$key" in
      $'\e')
        read -rsn2 -t 0.05 -u 3 key || true
        case "$key" in
          '[A') selected=$(((selected + count - 1) % count)) ;;
          '[B') selected=$(((selected + 1) % count)) ;;
        esac
        ;;
      k) selected=$(((selected + count - 1) % count)) ;;
      j) selected=$(((selected + 1) % count)) ;;
      [1-9]) if [ "$key" -le "$count" ]; then selected=$((key - 1)); fi ;;
      '')
        printf '\e[?25h'
        CHOICE=$selected
        return
        ;;
    esac
    printf '\e[%dA' "$count"
  done
}
describe() {
  case "$1" in *"|"*) printf '%s' "${1#*|}" ;; esac
}

# --- Checks for answers ---

is_ipv4() {
  local part
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  for part in ${1//./ }; do [ "$part" -le 255 ] || return 1; done
}
is_ipv6() { [[ "$1" == *:* ]] && [[ "$1" =~ ^[0-9a-fA-F:]+$ ]]; }
is_ip() { is_ipv4 "$1" || is_ipv6 "$1"; }
# Addresses only a local network reaches, or none.
is_private() {
  case "$1" in
    10.* | 127.* | 192.168.* | 169.254.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
    [fF][cCdD]*:* | [fF][eE][89abAB]*:* | ::1) return 0 ;;
  esac
  return 1
}
check_domain() {
  local name="${1,,}"
  if [ ${#name} -le 253 ] && [[ "$name" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$ ]]; then return 0; fi
  if is_ip "$1"; then warn "That's an IP address. Go back and pick the IP address instead."; else warn "That isn't a domain name, such as chat.example.com."; fi
  return 1
}
check_ip() {
  if is_ip "$1"; then return 0; fi
  warn "That isn't an IP address, such as 203.0.113.7."
  return 1
}
check_port() {
  if [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; then
    if port_free "$1" tcp; then return 0; fi
    warn "Something else is on port $1 already."
    return 1
  fi
  warn "Pick a port from 1024 to 65535. Lower ones would need the server to run with more power than it should."
  return 1
}
check_file() {
  if [ -r "$1" ]; then return 0; fi
  warn "Can't read $1."
  return 1
}

# --- This machine ---

# Who's listening on a port, by program name, if anyone.
port_user() {
  local flags=-Hltnp
  [ "${2:-tcp}" = udp ] && flags=-Hlunp
  ss "$flags" "sport = :$1" 2>/dev/null | grep -o 'users:(("[^"]*"' | head -n1 | cut -d'"' -f2 || true
}
# Whether a port is free, counting Zuna's own as free, since they're about to be set up again.
port_free() {
  local flags=-Hltn user
  [ "${2:-tcp}" = udp ] && flags=-Hlun
  [ -z "$(ss "$flags" "sport = :$1" 2>/dev/null)" ] && return 0
  user="$(port_user "$1" "${2:-tcp}")"
  [ "$user" = zuna-server ] || [ "$user" = livekit-server ]
}
# The first free port from START on.
free_port() {
  local port="$1"
  while ! port_free "$port" "${2:-tcp}"; do port=$((port + 1)); done
  echo "$port"
}
# This machine's own addresses, each as "address interface", public ones first.
own_addresses() {
  local address interface
  ip -o addr show scope global 2>/dev/null | grep -v -e temporary -e deprecated -e tentative | awk '{ split($4, a, "/"); print a[1], $2 }' |
    while read -r address interface; do
      if is_private "$address"; then echo "1 $address $interface"; else echo "0 $address $interface"; fi
    done | sort -s -k1,1 | cut -d' ' -f2-
}
is_own_address() {
  own_addresses | awk '{ print $1 }' | grep -qxF "$1"
}

pkg_install() {
  if [ "$PKG" = apt ]; then
    fresh_lists
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@"
  else
    dnf install -y -q "$@"
  fi
}
# A new machine's package lists can be empty, or too old to download from.
fresh_lists() {
  [ -n "$(find /var/lib/apt/lists -maxdepth 1 -name '*Packages*' -mmin -60 2>/dev/null)" ] || apt-get update -q
}
pkg_available() {
  if [ "$PKG" = apt ]; then
    fresh_lists >/dev/null 2>&1 || true
    [ -n "$(apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ && $2 != "(none)" { print $2 }')" ]
  else
    dnf -q list --available "$1" >/dev/null 2>&1 || rpm -q "$1" >/dev/null 2>&1
  fi
}

check_machine() {
  printf '\n  %s%s zuna%s %s server setup\n\n' "$B" "$MARK" "$R" "$DOT"
  say "This sets up a Zuna server here, step by step."
  say "Nothing changes until you confirm at the end."
  echo
  [ "$(id -u)" = 0 ] || fail "Run this with sudo: sudo $0"
  [ -d /run/systemd/system ] || fail "This needs a Linux machine running systemd."
  if command -v apt-get >/dev/null; then
    PKG=apt
  elif command -v dnf >/dev/null; then
    PKG=dnf
  else
    fail "This installs what it needs with apt or dnf, and found neither."
  fi
  case "$(uname -m)" in
    x86_64 | amd64) ARCH=amd64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) fail "Zuna runs on amd64 and arm64, and this machine is $(uname -m)." ;;
  esac
  [ -d "$SRC/.git" ] || fail "$SRC isn't a git checkout of Zuna. Clone it first, as docs/SELF_HOSTING.md shows."
  local name memory swap free
  # shellcheck source=/dev/null
  name="$(. /etc/os-release && echo "${PRETTY_NAME:-Linux}")"
  good "$name $DOT $ARCH $DOT systemd $DOT $PKG"

  memory="$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
  swap="$(awk '/^SwapTotal:/ { print int($2 / 1024) }' /proc/meminfo)"
  free="$(df -Pm /var | awk 'NR == 2 { print $4 }')"
  SWAP_FILE=0
  # Building the server takes about a gigabyte, besides what's running already.
  if [ $((memory + swap)) -lt 1800 ]; then
    warn "$memory MB of memory, which is too little to build the server"
    SWAP_FILE=1
  else
    good "$memory MB of memory $DOT $((free / 1024)) GB free"
  fi
  if [ "$free" -lt 2048 ]; then
    warn "Only $free MB free in /var. Building needs about 2 GB."
  fi

  # Updates run from this checkout as root, so only root may change it.
  FIX_CHECKOUT=0
  if [ "$(stat -c %U "$SRC")" != root ] || [ -n "$(find "$SRC/deploy/update.sh" "$SRC/.git" -maxdepth 0 -perm /022 2>/dev/null)" ]; then
    FIX_CHECKOUT=1
  fi

  local user80 user443 user
  user80="$(port_user 80)"
  user443="$(port_user 443)"
  if [ -n "$user80" ] && [ "$user80" = "$user443" ]; then
    warn "$user80 is using ports 80 and 443"
  else
    [ -n "$user80" ] && warn "$user80 is using port 80"
    [ -n "$user443" ] && warn "$user443 is using port 443"
  fi
  PROXY_FOUND=""
  PROXY_KIND=""
  for user in "$user443" "$user80"; do
    case "$user" in
      "") ;;
      caddy) PROXY_KIND=caddy ;;
      nginx) PROXY_KIND=nginx ;;
      apache2 | httpd) PROXY_KIND=apache ;;
      docker-proxy) PROXY_KIND=docker ;;
      *) PROXY_KIND=other ;;
    esac
    [ -n "$user" ] && PROXY_FOUND="$user" && break
  done
  # Something else on the other of the two ports leaves Caddy no room, and a found proxy no say.
  if [ -n "$user80" ] && [ -n "$user443" ] && [ "$user80" != "$user443" ]; then PROXY_KIND=other; PROXY_FOUND="$user443 and $user80"; fi
}

# A server set up here already: update it, or go through the questions again.
check_existing() {
  local existing=""
  [ -r /etc/zuna/update.conf ] && existing="$(sed -n 's/^SERVER_DOMAIN="\(.*\)"$/\1/p' /etc/zuna/update.conf)"
  [ -n "$existing" ] || return 0
  if [ -z "$DOMAIN$IP" ]; then
    if is_ip "$existing"; then IP="$existing"; else DOMAIN="$existing"; fi
  fi
  heading "Zuna is set up here already, at $existing"
  choose 0 "Update it|to the newest version, keeping its settings" "Set it up again|answering the questions again" "Quit|"
  case "$CHOICE" in
    0)
      [ "$DRY" = 1 ] && { say "Would run: $SRC/deploy/update.sh"; exit 0; }
      exec "$SRC/deploy/update.sh"
      ;;
    2) exit 0 ;;
  esac
}

# --- Questions ---

ask_address() {
  CLOUDFLARE_FOUND=0
  POINTS_HERE=""
  DOMAIN_ADDRESSES=""
  heading "How will people reach this server?"
  local selected=0
  [ -n "$IP" ] && selected=1
  if [ -z "$DOMAIN$IP" ] || [ "$YES" = 0 ]; then
    if [ "$YES" = 1 ]; then fail "Say where people reach the server, with --domain or --ip."; fi
    choose "$selected" "By a domain name|such as chat.example.com" "By its IP address|no domain needed"
  else
    CHOICE=$selected
    printf '  %s %s\n' "$PICK" "${DOMAIN:-$IP}"
  fi
  if [ "$CHOICE" = 0 ]; then
    IP=""
    if [ "$YES" = 0 ]; then
      echo
      ask "Domain:" "$DOMAIN" check_domain
      DOMAIN="${ANSWER,,}"
    else
      check_domain "$DOMAIN" || exit 1
      DOMAIN="${DOMAIN,,}"
    fi
    look_up_domain
  else
    DOMAIN=""
    ask_ip
  fi
}

# Where the domain points, and whether Cloudflare's in front.
look_up_domain() {
  local addresses address
  addresses="$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{ print $1 }' | sort -u || true)"
  if curl -sI --max-time 5 "http://$DOMAIN/" 2>/dev/null | tr -d '\r' | grep -qi -e '^cf-ray:' -e '^server: cloudflare'; then
    CLOUDFLARE_FOUND=1
  fi
  for address in $addresses; do
    if is_own_address "$address"; then POINTS_HERE="$address"; break; fi
  done
  echo
  if [ -z "$addresses" ]; then
    warn "$DOMAIN doesn't point anywhere yet."
    dim "Give it an A record, or AAAA, with this server's public address."
    dim "Certificates can't be had until it does."
  elif [ "$CLOUDFLARE_FOUND" = 1 ]; then
    good "$DOMAIN is behind Cloudflare"
  elif [ -n "$POINTS_HERE" ]; then
    good "$DOMAIN points here, at $POINTS_HERE"
  else
    warn "$DOMAIN points at ${addresses//$'\n'/, }, which isn't on this machine."
    dim "That's as it should be behind a router, which has to pass ports on to this machine."
    dim "The end of the setup lists which."
  fi
  DOMAIN_ADDRESSES="$addresses"
  ask_public_ip
}

# Calls' media goes straight to this machine, so LiveKit says where that is,
# rather than asking a STUN server on the internet.
ask_public_ip() {
  if [ "$PUBLIC_IP_GIVEN" = 1 ]; then check_ip "$PUBLIC_IP" || exit 1; return; fi
  if [ -n "$POINTS_HERE" ] && [ "$CLOUDFLARE_FOUND" = 0 ]; then PUBLIC_IP="$POINTS_HERE"; return; fi
  [ "$YES" = 1 ] && fail "Say which address calls reach this machine at, with --public-ip."
  heading "What's this machine's public IP address?"
  if [ "$CLOUDFLARE_FOUND" = 1 ]; then
    say "Calls' media comes straight here, not through Cloudflare."
  else
    say "Calls' media comes straight here, not through the proxy."
  fi
  echo
  local options=() values=() address interface
  if [ "$CLOUDFLARE_FOUND" = 0 ]; then
    for address in $DOMAIN_ADDRESSES; do
      is_private "$address" && continue
      options+=("$address|where $DOMAIN points")
      values+=("$address")
    done
  fi
  while read -r address interface; do
    [ -n "$address" ] || continue
    if is_private "$address"; then
      options+=("$address|this machine's, on $interface, only reachable on its network")
    else
      options+=("$address|this machine's, on $interface")
    fi
    values+=("$address")
  done < <(own_addresses)
  options+=("Another address|type it in")
  choose 0 "${options[@]}"
  if [ "$CHOICE" -lt ${#values[@]} ]; then
    PUBLIC_IP="${values[CHOICE]}"
  else
    echo
    ask "Public address:" "$PUBLIC_IP" check_ip
    PUBLIC_IP="$ANSWER"
  fi
}

ask_ip() {
  if [ "$YES" = 1 ]; then
    check_ip "$IP" || exit 1
  else
    heading "Which address will people use?"
    local options=() values=() address interface
    while read -r address interface; do
      [ -n "$address" ] || continue
      if is_private "$address"; then
        options+=("$address|this machine's, on $interface, only reachable on its network")
      else
        options+=("$address|this machine's, on $interface")
      fi
      values+=("$address")
    done < <(own_addresses)
    options+=("Another address|behind a router or NAT, type it in")
    local selected=0 i
    for i in "${!values[@]}"; do [ "${values[i]}" = "$IP" ] && selected=$i; done
    choose "$selected" "${options[@]}"
    if [ "$CHOICE" -lt ${#values[@]} ]; then
      IP="${values[CHOICE]}"
    else
      echo
      ask "Address:" "$IP" check_ip
      IP="$ANSWER"
    fi
  fi
  [ -n "$PORT" ] || PORT="$(free_port 9660)"
  if [ "$YES" = 1 ]; then
    check_port "$PORT" || exit 1
  else
    echo
    ask "Port:" "$PORT" check_port
    PORT="$ANSWER"
  fi
  PUBLIC_IP="$IP"
  if ! is_own_address "$IP"; then
    dim "The router has to pass port $PORT on to this machine, as the same port, and the ports"
    dim "for calls too, which the end of the setup lists."
  fi
}

ask_cloudflare() {
  [ -n "$DOMAIN" ] && [ "$CLOUDFLARE_FOUND" = 1 ] || { CLOUDFLARE_MODE=""; return 0; }
  if [ "$YES" = 1 ]; then
    [ -n "$CLOUDFLARE_MODE" ] || fail "$DOMAIN is behind Cloudflare. Say its SSL/TLS mode with --cloudflare strict, full or flexible."
  else
    local selected=0
    case "$CLOUDFLARE_MODE" in full) selected=1 ;; flexible) selected=2 ;; esac
    heading "Which SSL/TLS mode is $DOMAIN set to in Cloudflare?"
    dim "It's under SSL/TLS, Overview, in Cloudflare's dashboard."
    echo
    choose "$selected" "Full (strict)|recommended" "Full|" "Flexible|"
    case "$CHOICE" in 0) CLOUDFLARE_MODE=strict ;; 1) CLOUDFLARE_MODE=full ;; 2) CLOUDFLARE_MODE=flexible ;; esac
  fi
  case "$CLOUDFLARE_MODE" in
    full)
      alert "With Full, Cloudflare doesn't check this machine's certificate, so whoever" \
        "can get between the two could pose as your server. Full (strict) checks it."
      ;;
    flexible)
      alert "${B}Flexible doesn't encrypt anything between Cloudflare and this machine.${R}" \
        "Sign-ins, session tokens and who talks to whom when would cross the internet" \
        "in the clear, for anyone on the way to read or change. Messages stay encrypted," \
        "end to end. Full (strict), with a free Cloudflare origin certificate, avoids this."
      if ! yes_no "Go on with Flexible anyway?" n; then
        [ "$YES" = 1 ] && exit 1
        CLOUDFLARE_MODE=strict
        ask_cloudflare
      fi
      ;;
  esac
}

ask_proxy() {
  PROXY_NEW=0
  PROXY_WHERE=here
  PROXY_ADDRESS=""
  LISTEN=127.0.0.1
  [ -n "$DOMAIN" ] || return 0
  heading "Reverse proxy"
  local selected
  case "$PROXY_KIND" in
    "")
      say "Nothing is on ports 80 and 443 yet."
      echo
      selected=0
      [ "$PROXY" = manual ] && selected=1
      choose "$selected" "Install Caddy and set it up for me|it gets and renews the certificate itself" \
        "I'll set up a proxy myself|on this machine or another"
      if [ "$CHOICE" = 0 ]; then PROXY=auto; PROXY_KIND=caddy; PROXY_NEW=1; else PROXY=manual; fi
      ;;
    caddy | nginx | apache)
      say "Found $(proxy_name) on $(proxy_ports)."
      echo
      selected=1
      [ "$PROXY" = auto ] && selected=0
      choose "$selected" "Set it up for me|adds a site to $(proxy_name), checks it, reloads it" \
        "I'll do it myself|shows what to add, then checks that it works"
      if [ "$CHOICE" = 0 ]; then PROXY=auto; else PROXY=manual; fi
      ;;
    docker)
      say "A Docker container is on ports 80 and 443, so it's yours to set up."
      PROXY=manual
      ;;
    *)
      say "$PROXY_FOUND is on the ports a proxy needs, so it's yours to set up,"
      say "or free them and run this again."
      PROXY=manual
      ;;
  esac
  [ "$PROXY" = manual ] || return 0
  if [ "$PROXY_KIND" = docker ]; then
    # A container reaches this machine at Docker's bridge, not at 127.0.0.1.
    LISTEN="$(ip -o -4 addr show docker0 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }' | head -n1 || true)"
    LISTEN="${LISTEN:-172.17.0.1}"
    PROXY_ADDRESS="172.16.0.0/12"
    return 0
  fi
  [ "$YES" = 1 ] && return 0
  echo
  choose 0 "On this machine|" "On another machine|Zuna listens on a private address for it"
  [ "$CHOICE" = 0 ] && return 0
  PROXY_WHERE=elsewhere
  echo
  ask "The proxy's address:" "" check_ip
  PROXY_ADDRESS="$ANSWER"
  heading "Which of this machine's addresses does the proxy reach?"
  local options=() values=() address interface
  while read -r address interface; do
    [ -n "$address" ] || continue
    options+=("$address|on $interface")
    values+=("$address")
  done < <(own_addresses)
  choose 0 "${options[@]}"
  LISTEN="${values[CHOICE]}"
}
# Whether SELinux stops nginx or Apache connecting to Zuna, as it does until Zuna's
# port counts as a web port and httpd_can_network_relay lets them reach web ports.
# That's narrower than httpd_can_network_connect, which lets them reach any port.
selinux_in_the_way() {
  [ "$PROXY_KIND" = nginx ] || [ "$PROXY_KIND" = apache ] || return 1
  command -v getenforce >/dev/null && [ "$(getenforce 2>/dev/null)" = Enforcing ]
}
# Lets them: Zuna's port as a web port, unless it's one already, and the switch on.
selinux_allow() {
  command -v semanage >/dev/null || pkg_install policycoreutils-python-utils
  if ! semanage port -l | awk '$1 == "http_port_t" || $1 == "http_cache_port_t"' | grep -qw "$SERVER_PORT"; then
    semanage port -a -t http_port_t -p tcp "$SERVER_PORT" 2>/dev/null || semanage port -m -t http_port_t -p tcp "$SERVER_PORT"
  fi
  setsebool -P httpd_can_network_relay 1
}
proxy_ports() {
  local on80 on443
  on80="$(port_user 80)"
  on443="$(port_user 443)"
  if [ -n "$on80" ] && [ -n "$on443" ]; then echo "ports 80 and 443"; elif [ -n "$on80" ]; then echo "port 80"; else echo "port 443"; fi
}
proxy_name() {
  case "$PROXY_KIND" in caddy) echo Caddy ;; nginx) echo nginx ;; apache) echo Apache ;; *) echo "your proxy" ;; esac
}

# Whether $1 is a version at least $2, as dotted numbers.
version_at_least() {
  [ -n "$1" ] && [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]
}

# What connections to this server agree on keys with. ML-KEM-768 and X25519 together, which a
# quantum computer can't open later, where whatever speaks TLS in front of Zuna knows them: Zuna
# itself, Caddy from 2.10, and nginx or Apache on OpenSSL 3.5 or newer (docs/POST_QUANTUM.md).
# Anything older agrees on X25519 alone, and the apps still connect.
key_agreement() {
  local both="ML-KEM-768 with X25519" version
  if [ -n "$IP" ]; then echo "$both, by Zuna itself"; return; fi
  if [ -n "$CLOUDFLARE_MODE" ]; then echo "Cloudflare's, which offers $both"; return; fi
  if [ "$PROXY" != auto ]; then echo "your proxy's: $both from Caddy 2.10, or nginx and Apache on OpenSSL 3.5"; return; fi
  case "$PROXY_KIND" in
    caddy)
      version="$(caddy version 2>/dev/null | grep -o '^v[0-9][0-9.]*' | tr -d v || true)"
      if [ "$PROXY_NEW" = 1 ] || version_at_least "$version" 2.10; then echo "$both, by Caddy"; else echo "X25519 alone: Caddy ${version:-here} is older than 2.10"; fi
      ;;
    *)
      version="$(openssl version 2>/dev/null | awk '{ print $2 }' | grep -o '^[0-9][0-9.]*' || true)"
      if version_at_least "$version" 3.5; then echo "$both, by $(proxy_name)"; else echo "X25519 alone: this system's OpenSSL ${version:-} is older than 3.5"; fi
      ;;
  esac
}

ask_certificate() {
  CERT_SOURCE=""
  [ -n "$DOMAIN" ] && [ "$PROXY" = auto ] || return 0
  [ "$CLOUDFLARE_MODE" = flexible ] && return 0
  if [ "$CERT_GIVEN" = 1 ]; then check_certificate || exit 1; CERT_SOURCE=files; return 0; fi
  # Caddy gets its own, unless Cloudflare is in the way of Let's Encrypt.
  if [ "$PROXY_KIND" = caddy ] && [ "$CLOUDFLARE_FOUND" = 0 ]; then CERT_SOURCE=caddy; return 0; fi
  [ "$YES" = 1 ] && [ "$CLOUDFLARE_FOUND" = 1 ] && fail "Behind Cloudflare, give the proxy its certificate with --cert and --key, such as a Cloudflare origin certificate."
  heading "Certificate for $DOMAIN"
  local found="" found_key="" options=() choices=()
  if [ "$PROXY_KIND" != caddy ]; then
    find_certificate
    found="$FOUND_CERT"
    found_key="$FOUND_KEY"
  fi
  if [ -n "$found" ]; then
    say "Found one for $(certificate_names "$found"), in $(dirname "$found"),"
    say "valid until $(date -d "$(openssl x509 -in "$found" -noout -enddate | cut -d= -f2)" '+%-d %B %Y')."
    echo
    options+=("Use it|")
    choices+=(found)
  fi
  if [ "$CLOUDFLARE_FOUND" = 1 ]; then
    say "Behind Cloudflare, a Cloudflare origin certificate is simplest: free, valid"
    say "for up to 15 years, and made under SSL/TLS, Origin Server, in its dashboard."
    say "Save the certificate and its key as files here, then give their paths."
    echo
    options+=("Use my own certificate files|such as a Cloudflare origin certificate")
    choices+=(files)
  fi
  if [ "$PROXY_KIND" = caddy ]; then
    options+=("Let Caddy get one from Let's Encrypt|if Cloudflare passes plain HTTP through")
    choices+=(caddy)
  else
    options+=("Get one from Let's Encrypt|with certbot, which renews it")
    choices+=(certbot)
  fi
  [ "$CLOUDFLARE_FOUND" = 1 ] || { options+=("Use my own certificate files|"); choices+=(files); }
  choose 0 "${options[@]}"
  CERT_SOURCE="${choices[CHOICE]}"
  case "$CERT_SOURCE" in
    found) CERT="$found" KEY="$found_key" CERT_SOURCE=files ;;
    files)
      while :; do
        echo
        ask "Certificate file:" "$CERT" check_file
        CERT="$ANSWER"
        ask "Key file:" "$KEY" check_file
        KEY="$ANSWER"
        check_certificate && break
      done
      ;;
  esac
}

# A certificate already here that covers the domain for at least another week,
# from what nginx uses or what certbot keeps. Sets FOUND_CERT and FOUND_KEY.
find_certificate() {
  FOUND_CERT=""
  FOUND_KEY=""
  local pairs="" cert key
  if [ "$PROXY_KIND" = nginx ]; then
    pairs="$(nginx -T 2>/dev/null | tr -d ';' | awk '$1 == "ssl_certificate" { c = $2 } $1 == "ssl_certificate_key" && c { print c, $2; c = "" }' || true)"
  fi
  for cert in /etc/letsencrypt/live/*/fullchain.pem; do
    [ -f "$cert" ] && pairs="$pairs"$'\n'"$cert $(dirname "$cert")/privkey.pem"
  done
  while read -r cert key; do
    [ -n "$cert" ] && [ -r "$cert" ] && [ -r "$key" ] || continue
    if openssl x509 -in "$cert" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q 'does match' &&
      openssl x509 -in "$cert" -noout -checkend 604800 >/dev/null 2>&1; then
      FOUND_CERT="$cert"
      FOUND_KEY="$key"
      return
    fi
  done <<<"$pairs"
}

# The names a certificate is for.
certificate_names() {
  local names
  names="$(openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null | grep -o 'DNS:[^,]*' | cut -d: -f2 | paste -sd, - | sed 's/,/, /g' || true)"
  [ -n "$names" ] || names="$(openssl x509 -in "$1" -noout -subject -nameopt multiline 2>/dev/null | sed -n 's/^ *commonName *= *//p')"
  echo "${names:-$DOMAIN}"
}

# Whether CERT names the domain, goes with KEY and is still good.
check_certificate() {
  if ! openssl x509 -in "$CERT" -noout >/dev/null 2>&1; then warn "$CERT isn't a certificate."; return 1; fi
  if ! openssl x509 -in "$CERT" -noout -checkhost "$DOMAIN" 2>/dev/null | grep -q 'does match'; then
    warn "That certificate isn't for $DOMAIN."
    return 1
  fi
  if [ "$(openssl x509 -in "$CERT" -noout -pubkey 2>/dev/null)" != "$(openssl pkey -in "$KEY" -pubout 2>/dev/null)" ]; then
    warn "That key doesn't go with that certificate."
    return 1
  fi
  if ! openssl x509 -in "$CERT" -noout -checkend 0 >/dev/null 2>&1; then
    warn "That certificate has expired."
    return 1
  fi
  dim "Valid until $(date -d "$(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)" '+%-d %B %Y'). This script won't renew it."
}

ask_firewall() {
  FIREWALL_KIND=""
  FIREWALL_FOUND=""
  OPEN=()
  if [ -n "$IP" ]; then
    OPEN+=("$PORT/tcp")
  elif [ "$PROXY_WHERE" = elsewhere ]; then
    OPEN+=("$SERVER_PORT/tcp from $PROXY_ADDRESS")
  elif [ "$PROXY" = auto ]; then
    OPEN+=(80/tcp 443/tcp)
  fi
  OPEN+=("$VOICE_TCP_PORT/tcp" "$VOICE_UDP_PORT/udp")
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    FIREWALL_KIND=ufw
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    FIREWALL_KIND=firewalld
  fi
  FIREWALL_FOUND="$FIREWALL_KIND"
  [ "$FIREWALL" = 1 ] || { FIREWALL_KIND=""; return 0; }
  [ -n "$FIREWALL_KIND" ] || return 0
  heading "Firewall"
  if yes_no "$FIREWALL_KIND is on. Open $(open_list) in it?" y; then :; else FIREWALL_KIND=""; fi
}

# The ports to open, as people read them.
open_list() {
  local list
  list="$(printf '%s, ' "${OPEN[@]}")"
  echo "${list%, }"
}

pick_ports() {
  SERVER_PORT="$(free_port 9660)"
  VOICE_PORT="$(free_port 7880)"
  VOICE_TCP_PORT="$(free_port 7881)"
  [ "$VOICE_TCP_PORT" = "$VOICE_PORT" ] && VOICE_TCP_PORT="$(free_port $((VOICE_PORT + 1)))"
  VOICE_UDP_PORT="$(free_port 7882 udp)"
  if [ -n "$IP" ]; then SERVER_PORT="$PORT"; fi
}

summary() {
  SELINUX_FIX=0
  [ -n "$DOMAIN" ] && [ "$PROXY_WHERE" = here ] && selinux_in_the_way && SELINUX_FIX=1
  heading "Ready to set up"
  local rows=()
  if [ -n "$IP" ]; then
    rows+=("Address|https://$(url_host "$IP"):$PORT, with the server's own certificate")
  else
    rows+=("Address|https://$DOMAIN")
    case "$CLOUDFLARE_MODE" in
      strict) rows+=("Cloudflare|Full (strict)") ;;
      full) rows+=("Cloudflare|Full, which doesn't check the certificate") ;;
      flexible) rows+=("Cloudflare|${YELLOW}Flexible, unencrypted between Cloudflare and here${R}") ;;
    esac
    if [ "$PROXY" = auto ]; then
      if [ "$PROXY_NEW" = 1 ]; then rows+=("Proxy|Caddy, installed and set up by this script"); else rows+=("Proxy|$(proxy_name), with a site added for Zuna"); fi
      case "$CERT_SOURCE" in
        caddy) rows+=("Certificate|from Let's Encrypt, through Caddy") ;;
        certbot) rows+=("Certificate|from Let's Encrypt, through certbot") ;;
        files) rows+=("Certificate|$CERT") ;;
        "") rows+=("Certificate|none: Cloudflare's, in front") ;;
      esac
    else
      rows+=("Proxy|yours, $( [ "$PROXY_WHERE" = elsewhere ] && echo "on $PROXY_ADDRESS, reaching" || echo "reaching") http://$(url_host "$LISTEN"):$SERVER_PORT")
    fi
  fi
  rows+=("Key agreement|$(key_agreement)")
  rows+=("Voice channels|on $DOT media on $VOICE_TCP_PORT/tcp and $VOICE_UDP_PORT/udp, at $PUBLIC_IP")
  if [ -n "$DATABASE_URL" ]; then rows+=("Data|PostgreSQL, files in /var/lib/zuna"); else rows+=("Data|in /var/lib/zuna"); fi
  rows+=("Notifications|through the project's push relay, which only sees sealed pushes")
  if [ -n "$FIREWALL_KIND" ]; then
    rows+=("Firewall|opens $(open_list) in $FIREWALL_KIND")
  else
    rows+=("Firewall|unchanged $DOT open $(open_list) wherever yours is")
  fi
  [ "$PROXY" = auto ] && [ "$SELINUX_FIX" = 1 ] && rows+=("SELinux|lets $(proxy_name) reach Zuna: port $SERVER_PORT as a web port, with httpd_can_network_relay")
  [ "$PROXY_KIND" = caddy ] && [ "$CERT_SOURCE" = files ] && rows+=("Key|$KEY, made readable to Caddy's group")
  [ "$SWAP_FILE" = 1 ] && rows+=("Memory|adds a 2 GB swap file, /swapfile, for building")
  [ "$FIX_CHECKOUT" = 1 ] && rows+=("Checkout|$SRC becomes root's, as updates run from it as root")
  local row
  for row in "${rows[@]}"; do printf '  %-15s %s\n' "${row%%|*}" "${row#*|}"; done
  echo
}
url_host() {
  case "$1" in *:*) echo "[$1]" ;; *) echo "$1" ;; esac
}

# --- Doing it ---

# Runs a command with its output in the log, with LABEL and a spinner until it ends.
step() {
  local label="$1" pid status=0 start=$SECONDS frame=0
  shift
  printf '\n### %s\n' "$label" >>"$LOG"
  "$@" >>"$LOG" 2>&1 &
  pid=$!
  CHILD=$pid
  if [ "$LIVE" = 1 ]; then
    printf '\e[?25l'
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r\e[2K  %s %s %s%s%s' "${SPIN[frame % ${#SPIN[@]}]}" "$label" "$D" "$(took $start)" "$R"
      frame=$((frame + 1))
      sleep 0.1
    done
    printf '\e[?25h'
  fi
  wait "$pid" || status=$?
  CHILD=""
  if [ "$status" = 0 ]; then
    printf '%s  %s%s%s %s %s%s%s\n' "$CLEAR" "$GREEN" "$OK" "$R" "$label" "$D" "$(took $start)" "$R"
  else
    printf '%s  %s%s%s %s\n' "$CLEAR" "$RED" "$BAD" "$R" "$label"
    echo
    tail -n 20 "$LOG" | sed "s/^/  $D$BAR$R /"
    fail "That didn't work. The whole log is in $LOG."
  fi
}
took() {
  local seconds=$((SECONDS - $1))
  if [ "$seconds" -ge 60 ]; then echo "$((seconds / 60)) min $((seconds % 60)) s"; elif [ "$seconds" -ge 3 ]; then echo "$seconds s"; fi
}

# deploy/update.sh, shown as the steps it says it's on.
run_update() {
  local args=(--server "${DOMAIN:-$IP}" --voice on --server-port "$SERVER_PORT"
    --voice-port "$VOICE_PORT" --voice-tcp-port "$VOICE_TCP_PORT" --voice-udp-port "$VOICE_UDP_PORT"
    --voice-ip "$PUBLIC_IP")
  if [ -n "$DOMAIN" ]; then
    args+=(--listen "$LISTEN")
    # Always given, so that one left from an earlier setup doesn't stay.
    args+=(--trusted-proxies "${PROXY_ADDRESS:-$LOCAL_PROXIES}")
    # Behind Cloudflare, a request from it is from whoever it names.
    if [ "$CLOUDFLARE_FOUND" = 1 ]; then args+=(--behind-cloudflare on); else args+=(--behind-cloudflare off); fi
  fi
  [ -n "$DATABASE_URL" ] && args+=(--database-url "$DATABASE_URL")
  if [ "$DRY" = 1 ]; then
    say "$SRC/deploy/update.sh ${args[*]}"
    return
  fi
  local offset pid status=0 current="" frame=0 began=$SECONDS labels=() shown=0
  printf '\n### deploy/update.sh %s\n' "${args[*]}" >>"$LOG"
  offset=$(($(stat -c %s "$LOG") + 1))
  # In a session of its own, so that stopping this stops the whole build.
  setsid "$SRC/deploy/update.sh" "${args[@]}" >>"$LOG" 2>&1 &
  pid=$!
  CHILD=$pid
  [ "$LIVE" = 1 ] && printf '\e[?25l'
  while :; do
    # Each step it's begun since the last look, even one that's over already.
    mapfile -t labels < <(tail -c +"$offset" "$LOG" | sed -n 's/^==> //p')
    while [ "$shown" -lt ${#labels[@]} ]; do
      [ -n "$current" ] && printf '%s  %s%s%s %s %s%s%s\n' "$CLEAR" "$GREEN" "$OK" "$R" "$(update_step "$current")" "$D" "$(took $began)" "$R"
      current="${labels[shown]}"
      shown=$((shown + 1))
      began=$SECONDS
    done
    kill -0 "$pid" 2>/dev/null || break
    if [ "$LIVE" = 1 ] && [ -n "$current" ]; then
      printf '\r\e[2K  %s %s %s%s%s' "${SPIN[frame % ${#SPIN[@]}]}" "$(update_step "$current")" "$D" "$(took $began)" "$R"
      frame=$((frame + 1))
    fi
    sleep 0.2
  done
  [ "$LIVE" = 1 ] && printf '\e[?25h'
  wait "$pid" || status=$?
  CHILD=""
  if [ "$status" = 0 ]; then
    printf '%s  %s%s%s %s %s%s%s\n' "$CLEAR" "$GREEN" "$OK" "$R" "$(update_step "$current")" "$D" "$(took $began)" "$R"
  else
    printf '%s  %s%s%s %s\n' "$CLEAR" "$RED" "$BAD" "$R" "$(update_step "$current")"
    echo
    tail -n 20 "$LOG" | sed "s/^/  $D$BAR$R /"
    fail "That didn't work. The whole log is in $LOG."
  fi
}
update_step() {
  case "$1" in
    "Checking the tools") echo "Installing tools" ;;
    "Pulling updates") echo "Getting the newest code" ;;
    Building*) echo "Building the server" ;;
    Installing) echo "Installing" ;;
    Restarting) echo "Starting Zuna and LiveKit" ;;
    "") echo "Installing Zuna" ;;
    *) echo "$1" ;;
  esac
}

make_swap() {
  rm -f /swapfile
  touch /swapfile
  # btrfs only swaps to a file it doesn't copy on write.
  chattr +C /swapfile 2>/dev/null || true
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  if ! swapon /swapfile; then
    rm -f /swapfile
    return 1
  fi
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
}

fix_checkout() {
  chown -R root:root "$SRC"
  chmod -R go-w "$SRC"
}

open_firewall() {
  local rule port proto from
  for rule in "${OPEN[@]}"; do
    port="${rule%%/*}"
    proto="${rule#*/}"
    proto="${proto%% *}"
    from=""
    case "$rule" in *" from "*) from="${rule##* from }" ;; esac
    if [ "$FIREWALL_KIND" = ufw ]; then
      if [ -n "$from" ]; then ufw allow from "$from" to any port "$port" proto "$proto"; else ufw allow "$port/$proto"; fi
    elif [ -n "$from" ]; then
      firewall-cmd --permanent --add-rich-rule="rule family=\"$(is_ipv4 "$from" && echo ipv4 || echo ipv6)\" source address=\"$from\" port port=\"$port\" protocol=\"$proto\" accept"
    else
      firewall-cmd --permanent --add-port="$port/$proto"
    fi
  done
  [ "$FIREWALL_KIND" = firewalld ] && firewall-cmd --reload
  return 0
}

# --- Proxy settings ---

# Zuna, as the proxy reaches it.
upstream() { echo "$(url_host "$LISTEN"):$SERVER_PORT"; }
has_ipv6() { [ -f /proc/net/if_inet6 ]; }

caddy_site() {
  local scheme=""
  [ "$CLOUDFLARE_MODE" = flexible ] && scheme="http://"
  echo "# Zuna, at $DOMAIN. Written by deploy/install.sh."
  echo "$scheme$DOMAIN {"
  if [ "$CERT_SOURCE" = files ]; then
    echo "	tls $CERT $KEY"
  elif [ -n "$ACME_CA" ] && [ -z "$scheme" ]; then
    printf '\ttls {\n\t\tca %s\n\t\tca_root %s\n\t}\n' "$ACME_CA" "$ACME_CA_ROOT"
  fi
  # Caddy sets X-Forwarded-For to who called, which behind Cloudflare is one of its
  # addresses, and passes on CF-Connecting-IP, which then names the caller.
  echo "	reverse_proxy $(upstream)"
  echo "}"
}

# PART is "acme" for port 80 alone, where certbot proves the domain is ours, or "all".
nginx_site() {
  local part="$1"
  echo "# Zuna, at $DOMAIN. Written by deploy/install.sh."
  if [ "$CLOUDFLARE_MODE" = flexible ]; then
    echo "server {"
    nginx_listen 80
    nginx_proxy
    echo "}"
    return
  fi
  echo "server {"
  nginx_listen 80
  if [ "$CERT_SOURCE" = certbot ]; then
    echo "    location /.well-known/acme-challenge/ {"
    echo "        root $ACME_ROOT;"
    echo "    }"
  fi
  echo "    location / {"
  echo "        return 301 https://\$host\$request_uri;"
  echo "    }"
  echo "}"
  [ "$part" = all ] || return 0
  echo
  echo "server {"
  nginx_listen "443 ssl"
  echo "    ssl_certificate $(site_cert);"
  echo "    ssl_certificate_key $(site_key);"
  nginx_proxy
  echo "}"
}
nginx_listen() {
  echo "    listen $1;"
  has_ipv6 && echo "    listen [::]:$1;"
  echo "    server_name $DOMAIN;"
}
nginx_proxy() {
  cat <<EOF

    # Files upload in 1 MiB chunks, and a change to a large group carries its whole tree.
    client_max_body_size 64m;

    location / {
        proxy_pass http://$(upstream);
        # WebSockets, for messages as they arrive and for voice channels.
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 1h;
    }
EOF
}

apache_site() {
  local part="$1"
  echo "# Zuna, at $DOMAIN. Written by deploy/install.sh."
  if [ "$CLOUDFLARE_MODE" = flexible ]; then
    echo "<VirtualHost *:80>"
    echo "    ServerName $DOMAIN"
    apache_proxy
    echo "</VirtualHost>"
    return
  fi
  echo "<VirtualHost *:80>"
  echo "    ServerName $DOMAIN"
  if [ "$CERT_SOURCE" = certbot ]; then
    echo "    Alias /.well-known/acme-challenge/ $ACME_ROOT/.well-known/acme-challenge/"
    echo "    <Directory $ACME_ROOT>"
    echo "        Require all granted"
    echo "    </Directory>"
  fi
  echo "    RewriteEngine on"
  echo "    RewriteCond %{REQUEST_URI} !^/\.well-known/acme-challenge/"
  echo "    RewriteRule ^ https://%{SERVER_NAME}%{REQUEST_URI} [R=301,L]"
  echo "</VirtualHost>"
  [ "$part" = all ] || return 0
  echo
  echo "<VirtualHost *:443>"
  echo "    ServerName $DOMAIN"
  echo "    SSLEngine on"
  echo "    SSLCertificateFile $(site_cert)"
  echo "    SSLCertificateKeyFile $(site_key)"
  apache_proxy
  echo "</VirtualHost>"
}
apache_proxy() {
  cat <<EOF
    ProxyPreserveHost On
    # WebSockets, for messages as they arrive and for voice channels.
    ProxyPass / http://$(upstream)/ upgrade=websocket timeout=3600
    ProxyPassReverse / http://$(upstream)/
    # Files upload in 1 MiB chunks, and a change to a large group carries its whole tree.
    LimitRequestBody 67108864
EOF
}

site_cert() {
  if [ "$CERT_SOURCE" = certbot ]; then echo "/etc/letsencrypt/live/$DOMAIN/fullchain.pem"; elif [ -n "$CERT" ]; then echo "$CERT"; else echo "/path/to/fullchain.pem"; fi
}
site_key() {
  if [ "$CERT_SOURCE" = certbot ]; then echo "/etc/letsencrypt/live/$DOMAIN/privkey.pem"; elif [ -n "$KEY" ]; then echo "$KEY"; else echo "/path/to/privkey.pem"; fi
}

# Where each proxy keeps a site, and how it's checked and reloaded.
site_file() {
  case "$PROXY_KIND" in
    caddy) echo /etc/caddy/Caddyfile.d/zuna.caddyfile ;;
    nginx) if [ -d /etc/nginx/sites-available ]; then echo /etc/nginx/sites-available/zuna.conf; else echo /etc/nginx/conf.d/zuna.conf; fi ;;
    apache) if [ -d /etc/apache2/sites-available ]; then echo /etc/apache2/sites-available/zuna.conf; else echo /etc/httpd/conf.d/zuna.conf; fi ;;
  esac
}
proxy_service() {
  case "$PROXY_KIND" in caddy) echo caddy ;; nginx) echo nginx ;; apache) if [ -d /etc/apache2 ]; then echo apache2; else echo httpd; fi ;; esac
}
proxy_test() {
  case "$PROXY_KIND" in
    caddy) caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile ;;
    nginx) nginx -t ;;
    apache) apachectl configtest ;;
  esac
}

# Writes the site, checks the proxy's settings and reloads it. If they don't
# check out, the site goes and the proxy is left as it was.
write_site() {
  local part="${1:-all}" file
  file="$(site_file)"
  install -d "$(dirname "$file")"
  case "$PROXY_KIND" in
    caddy) caddy_site ;;
    nginx) nginx_site "$part" ;;
    apache) apache_site "$part" ;;
  esac >"$file.new"
  [ -f "$file" ] && cp -p "$file" "$file.previous"
  mv -f "$file.new" "$file"
  enable_site
  if ! proxy_test; then
    if [ -f "$file.previous" ]; then mv -f "$file.previous" "$file"; else rm -f "$file"; disable_site; fi
    echo "$(proxy_name)'s settings didn't check out with Zuna's site, so it's as it was."
    return 1
  fi
  rm -f "$file.previous"
  systemctl enable --quiet "$(proxy_service)"
  if systemctl is-active --quiet "$(proxy_service)"; then systemctl reload "$(proxy_service)"; else systemctl start "$(proxy_service)"; fi
}
# Puts the site where the proxy reads it.
enable_site() {
  case "$PROXY_KIND" in
    caddy)
      # Fedora's Caddyfile reads Caddyfile.d already, and Debian's needs telling.
      if ! grep -qE '^\s*import\s+(/etc/caddy/)?Caddyfile\.d/(\*|zuna)\.caddyfile' /etc/caddy/Caddyfile; then
        printf '\n# Zuna, added by deploy/install.sh.\nimport /etc/caddy/Caddyfile.d/zuna.caddyfile\n' >>/etc/caddy/Caddyfile
      fi
      ;;
    nginx) if [ -d /etc/nginx/sites-enabled ]; then ln -sf /etc/nginx/sites-available/zuna.conf /etc/nginx/sites-enabled/zuna.conf; fi ;;
    apache)
      if command -v a2enmod >/dev/null; then
        a2enmod -q proxy proxy_http proxy_wstunnel ssl rewrite headers
        a2ensite -q zuna
      elif ! rpm -q mod_ssl >/dev/null 2>&1; then
        dnf install -y -q mod_ssl
        # Its settings name a certificate for localhost that Fedora only makes when Apache starts.
        systemctl start httpd-init.service 2>/dev/null || true
      fi
      ;;
  esac
}
disable_site() {
  case "$PROXY_KIND" in
    caddy) sed -i '/^# Zuna, added by deploy\/install.sh.$/d; /^import \/etc\/caddy\/Caddyfile.d\/zuna.caddyfile$/d' /etc/caddy/Caddyfile ;;
    nginx) rm -f /etc/nginx/sites-enabled/zuna.conf ;;
    apache) command -v a2dissite >/dev/null && a2dissite -q zuna ;;
  esac
  return 0
}

get_certificate() {
  install -d -m 0755 "$ACME_ROOT"
  write_site acme
  local args=(certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" --cert-name "$DOMAIN" --non-interactive
    --agree-tos --register-unsafely-without-email --deploy-hook "systemctl reload $(proxy_service)")
  [ -n "$ACME_CA" ] && args+=(--server "$ACME_CA")
  REQUESTS_CA_BUNDLE="${ACME_CA_ROOT:-${REQUESTS_CA_BUNDLE:-}}" certbot "${args[@]}"
}

# Caddy runs as its own user, which has to read the key.
let_caddy_read() {
  if [ "$PROXY_KIND" = caddy ] && [ -n "$KEY" ] && ! runuser -u caddy -- test -r "$KEY" 2>/dev/null; then
    chgrp caddy "$KEY"
    chmod g+r "$KEY"
    chmod o+x "$(dirname "$KEY")" 2>/dev/null || true
  fi
}

# For a proxy set up by hand: what to add, saved to copy, and what it needs.
show_manual() {
  heading "Set up your proxy"
  say "Point https://$DOMAIN at http://$(upstream)."
  local kind="$PROXY_KIND" file
  case "$kind" in caddy | nginx | apache) ;; *) kind="" ;; esac
  if [ -n "$kind" ] || [ "$PROXY_WHERE" = here ]; then
    [ -n "$kind" ] || kind=nginx
    file="$EXAMPLES/$kind.conf"
    install -d -m 0755 "$EXAMPLES"
    manual_site "$kind" >"$file"
    say "For $(PROXY_KIND="$kind" proxy_name) it's this, saved in $file:"
    echo
    sed "s/^/    $D/; s/\$/$R/" "$file"
  fi
  alert "${B}The proxy has to pass WebSockets on,${R} at /api/ws for messages as they arrive" \
    "and at /livekit/ for voice channels. Without them the apps sign in, but nothing" \
    "arrives until they reload, and nobody can join a call." \
    "It also has to allow uploads of 64 MB, and add X-Forwarded-For, so that limits" \
    "count each person rather than the proxy."
  if [ "$SELINUX_FIX" = 1 ]; then
    say "SELinux stops $(proxy_name) connecting to Zuna until you let it:"
    echo
    say "    sudo semanage port -a -t http_port_t -p tcp $SERVER_PORT"
    say "    sudo setsebool -P httpd_can_network_relay 1"
    echo
  fi
}

# The site as someone setting up KIND by hand would add it, with places for their certificate.
manual_site() {
  local PROXY_KIND="$1" CERT_SOURCE=files
  case "$1" in
    caddy) CERT_SOURCE=caddy caddy_site ;;
    nginx) nginx_site all ;;
    apache) apache_site all ;;
  esac
}

# --- Checking ---

# Whether the server answers at its address, as an app reaches it. Sets PROBLEM
# to what's wrong if it doesn't.
answers() {
  local url="$1" headers code status=0
  shift
  PROBLEM=""
  headers="$(mktemp)"
  code="$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --max-time 8 -L --max-redirs 5 "$@" "$url/healthz" 2>/dev/null)" || status=$?
  if [ "$status" = 0 ] && [ "$code" = 200 ]; then
    rm -f "$headers"
    websockets "$url" "$@"
    return
  fi
  local host="${url#https://}"
  host="${host%%/*}"
  case "$status" in
    0) ;;
    6) PROBLEM="${host%:*} doesn't point anywhere: give it an A or AAAA record" ;;
    7) PROBLEM="nothing answers at $host: the proxy may not be running, or a firewall turns it away" ;;
    28) PROBLEM="no answer from $host: a firewall or router is probably in the way" ;;
    35) PROBLEM="HTTPS couldn't start with $host" ;;
    47) PROBLEM="$host sends people round in circles: with Cloudflare's Flexible mode, the proxy mustn't send them on to HTTPS" ;;
    51 | 60) PROBLEM="$(certificate_problem "$host")" ;;
    *) PROBLEM="curl couldn't reach $url (error $status)" ;;
  esac
  if [ -z "$PROBLEM" ]; then
    case "$code" in
      502 | 503 | 504) PROBLEM="the proxy can't reach Zuna at http://$(upstream)" ;;
      521 | 522 | 523) PROBLEM="Cloudflare can't reach this machine: open port 443 to it, or 80 for Flexible" ;;
      525) PROBLEM="Cloudflare couldn't start HTTPS with this machine: in Full and Full (strict), the proxy has to serve HTTPS" ;;
      526) PROBLEM="Cloudflare won't accept this machine's certificate: in Full (strict) it has to be valid, as a Cloudflare origin certificate is" ;;
      403) if grep -qi '^cf-mitigated:' "$headers"; then PROBLEM="Cloudflare is showing a challenge: turn off Bot Fight Mode and Under Attack Mode for $host, as the apps can't solve one"; fi ;;
    esac
    [ -n "$PROBLEM" ] || PROBLEM="something answers at $url, but it isn't Zuna (HTTP $code)"
  fi
  rm -f "$headers"
  return 1
}
certificate_problem() {
  local host="$1" name="${1%:*}" port=443 cert
  [ "$host" != "$name" ] && port="${host##*:}"
  cert="$(echo | openssl s_client -connect "$name:$port" -servername "$name" 2>/dev/null | openssl x509 2>/dev/null)" || true
  if [ -z "$cert" ]; then echo "the certificate at $host isn't trusted"; return; fi
  if ! openssl x509 -noout -checkend 0 <<<"$cert" >/dev/null 2>&1; then echo "the certificate at $host has expired"; return; fi
  if ! openssl x509 -noout -checkhost "$name" <<<"$cert" 2>/dev/null | grep -q 'does match'; then echo "the certificate at $host is for another name"; return; fi
  echo "the certificate at $host isn't trusted: it's from an unknown authority, or the proxy doesn't send its intermediate certificates"
}
# Whether the WebSocket for messages, and LiveKit's address for calls, get through.
websockets() {
  local url="$1" code
  shift
  code="$(curl -s -o /dev/null -w '%{http_code}' --http1.1 --max-time 3 "$@" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)" "$url/api/ws" 2>/dev/null)" || true
  if [ "$code" != 101 ]; then
    PROBLEM="the proxy doesn't pass WebSockets on to Zuna (HTTP $code at /api/ws), so messages won't arrive as they're sent"
    return 1
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" "$url/livekit/" 2>/dev/null)" || true
  if [ "$code" != 200 ]; then
    PROBLEM="LiveKit doesn't answer at /livekit/ (HTTP $code), so voice channels can't be joined"
    return 1
  fi
}

# The pin in the server's links, as curl takes it: base64 rather than base64url.
pin() {
  local link="$1" pin
  pin="${link##*#pin=}"
  pin="$(printf '%s' "$pin" | tr '_-' '/+')"
  while [ $((${#pin} % 4)) != 0 ]; do pin="$pin="; done
  echo "$pin"
}

check_server() {
  heading "Checking"
  local url args=() wait=0 local_args=() deadline
  if [ -n "$IP" ]; then
    url="https://$(url_host "$IP"):$PORT"
    args=(-k --pinnedpubkey "sha256//$(pin "$(sign_in_address)")")
    is_own_address "$IP" || args+=(--connect-to "$(url_host "$IP"):$PORT:127.0.0.1:$PORT")
  else
    url="https://$DOMAIN"
    # Caddy can take a minute to get the first certificate.
    [ "$PROXY" = auto ] && wait=90
  fi
  while :; do
    deadline=$((SECONDS + wait))
    while :; do
      if answers "$url" "${args[@]}"; then
        good "Zuna answers at $url, with WebSockets and voice"
        if [ -n "$IP" ] && ! is_own_address "$IP"; then
          dim "Checked on this machine. From outside, $IP:$PORT has to reach it through the router."
        fi
        return 0
      fi
      [ "$SECONDS" -lt "$deadline" ] || break
      sleep 3
    done
    # Through this machine's own proxy, it may work when the way in from outside doesn't.
    if [ -n "$DOMAIN" ] && [ "$PROXY_WHERE" = here ] && [ "$CLOUDFLARE_FOUND" = 0 ]; then
      local_args=(--resolve "$DOMAIN:443:127.0.0.1")
      local outside="$PROBLEM"
      if answers "$url" "${local_args[@]}"; then
        warn "It works on this machine, but not from outside: $outside."
        dim "A router or the provider's firewall has to let ports 80 and 443 through to here."
        return 0
      fi
      PROBLEM="$outside"
    fi
    warn "Not yet: $PROBLEM."
    [ "$YES" = 1 ] && return 1
    echo
    choose 0 "Check again|" "Skip the check|and check later with: curl $url/healthz"
    [ "$CHOICE" = 0 ] || return 1
    wait=0
  done
}

# The server prints its addresses at its first start.
setup_link() {
  journalctl -u zuna --no-pager -n 200 2>/dev/null | grep -o 'https://[^ ]*/invite/[^ ]*' | tail -n1 || true
}
sign_in_address() {
  journalctl -u zuna --no-pager -n 200 2>/dev/null | grep -o 'https://[^ ]*#pin=[^ ]*' | grep -v /invite/ | tail -n1 || true
}

done_screen() {
  local link checked="$1"
  link="$(setup_link)"
  echo
  local url="https://$DOMAIN"
  [ -n "$IP" ] && url="https://$(url_host "$IP"):$PORT"
  if [ "$checked" = 1 ]; then
    printf '  %s%s Zuna is running at %s%s\n' "$GREEN" "$OK" "$url" "$R"
  else
    printf '  %s%s %s%s\n' "$YELLOW" "$WARN" "Zuna is running here, but doesn't answer at $url yet" "$R"
  fi
  if [ -n "$link" ]; then
    echo
    say "Finish setup: open this one-time link in the Zuna app."
    say "It creates your owner account."
    [ "$checked" = 1 ] || dim "It works once the server answers at its address."
    echo
    say "  $B$link$R"
    if command -v qrencode >/dev/null; then
      echo
      qrencode -t ANSIUTF8 -m 2 "$link" | sed 's/^/  /'
    fi
  else
    echo
    say "It was set up before, so there's no setup link: sign in with your account."
  fi
  echo
  if [ -n "$IP" ]; then
    say "Share links whole, with what's after the #: the apps check the server by it."
    say "To sign in on another device, enter: $(sign_in_address)"
    say "Back up /var/lib/zuna/certificate.key: a new one would need new links for everyone."
    say "The web app can't reach a server without a domain."
    echo
  fi
  what_is_left
  printf '  %-10s %s\n' "Get apps" "https://zuna.chat" "Update" "sudo zuna-update" "Logs" "journalctl -u zuna" "Back up" "/var/lib/zuna"
  echo
}

# Where a proxy set up by hand points, and which ports have to be open, and
# forwarded behind a router, for what was chosen.
what_is_left() {
  local rows=() row public="${IP:-$PUBLIC_IP}" here
  if [ -n "$DOMAIN" ] && [ "$PROXY" = manual ]; then
    if [ "$PROXY_WHERE" = elsewhere ]; then say "${B}Your proxy, on $PROXY_ADDRESS${R}"; else say "${B}Your proxy${R}"; fi
    say "  https://$DOMAIN  ->  http://$(upstream), passing WebSockets on"
    echo
  fi
  if [ -n "$IP" ]; then
    rows+=("$PORT/tcp|the server, with its own certificate, from everyone")
  elif [ "$PROXY_WHERE" = elsewhere ]; then
    rows+=("$SERVER_PORT/tcp|from your proxy at $PROXY_ADDRESS alone")
  elif [ "$PROXY" = auto ] && [ "$CLOUDFLARE_FOUND" = 1 ]; then
    [ "$CLOUDFLARE_MODE" = flexible ] || rows+=("443/tcp|HTTPS, from Cloudflare")
    rows+=("80/tcp|from Cloudflare")
  elif [ "$PROXY" = auto ]; then
    rows+=("443/tcp|HTTPS, through $(proxy_name), from everyone")
    rows+=("80/tcp|for certificates, and to send http:// on to https://")
  fi
  rows+=("$VOICE_TCP_PORT/tcp|calls' media, from everyone, straight here and not through a proxy")
  rows+=("$VOICE_UDP_PORT/udp|calls' media, the same, and better for calls than TCP")
  say "${B}Ports to open${R}"
  for row in "${rows[@]}"; do printf '    %-9s %s\n' "${row%%|*}" "${row#*|}"; done
  if [ -n "$DOMAIN" ] && [ "$PROXY" = manual ] && [ "$PROXY_WHERE" = here ]; then
    say "  and what your proxy needs, usually 80/tcp and 443/tcp."
  fi
  if [ -n "$FIREWALL_KIND" ]; then
    dim "  $FIREWALL_KIND has them open. Open them in your provider's firewall too, if it has one."
  elif [ -n "$FIREWALL_FOUND" ]; then
    warn "$FIREWALL_FOUND is on here, and these aren't open in it."
  else
    dim "  Nothing here blocks them. Open them in your provider's firewall, if it has one."
  fi
  # A public address that isn't this machine's is a router's, which has to pass them on.
  if [ -n "$public" ] && ! is_own_address "$public"; then
    here="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([^ ]*\).*/\1/p')"
    here="${here:-$(own_addresses | awk '{ print $1; exit }')}"
    warn "People reach this machine at $public, which is a router's."
    say "  On the router, forward each of these ports to $here, as the same port."
  fi
  echo
}

# --- The questions, then the work ---

check_machine
check_existing
while :; do
  ask_address
  pick_ports
  ask_cloudflare
  ask_proxy
  ask_certificate
  ask_firewall
  summary
  [ "$YES" = 1 ] && break
  choose 0 "Set it up|" "Change something|go through the questions again" "Quit|nothing has changed"
  case "$CHOICE" in 0) break ;; 2) exit 0 ;; esac
done

if [ "$DRY" = 1 ]; then
  heading "Would run"
  run_update
  if [ -n "$DOMAIN" ] && [ "$PROXY" = auto ]; then
    say "and write $(site_file):"
    echo
    case "$PROXY_KIND" in caddy) caddy_site ;; nginx) nginx_site all ;; apache) apache_site all ;; esac | sed 's/^/    /'
  fi
  exit 0
fi

CHANGING=1
install -m 0600 /dev/null "$LOG.new" && mv -f "$LOG.new" "$LOG"
heading "Setting up"
[ "$FIX_CHECKOUT" = 1 ] && step "Making $SRC root's" fix_checkout
[ "$SWAP_FILE" = 1 ] && step "Adding a swap file" make_swap
[ -n "$FIREWALL_KIND" ] && step "Opening the firewall" open_firewall
run_update
if [ -n "$DOMAIN" ] && [ "$PROXY" = auto ]; then
  [ "$PROXY_NEW" = 1 ] && step "Installing Caddy" pkg_install caddy
  if [ "$CERT_SOURCE" = certbot ]; then
    command -v certbot >/dev/null || step "Installing certbot" pkg_install certbot
    step "Getting a certificate from Let's Encrypt" get_certificate
  fi
  let_caddy_read
  [ "$SELINUX_FIX" = 1 ] && step "Letting $(proxy_name) reach Zuna" selinux_allow
  step "Setting up $(proxy_name)" write_site all
fi
if ! command -v qrencode >/dev/null && pkg_available qrencode; then
  pkg_install qrencode >>"$LOG" 2>&1 || true
fi
CHANGING=0

if [ -n "$DOMAIN" ] && [ "$PROXY" = manual ]; then
  show_manual
  if [ "$YES" = 0 ]; then
    printf '  Press Enter once the proxy is set up. '
    answer
  fi
fi
checked=0
if check_server; then checked=1; fi
done_screen "$checked"
