#!/usr/bin/env bash
# Checks deploy/install.sh, and deploy/update.sh through it, on real Linux
# machines: Debian 13, Ubuntu 24.04 and Fedora 43, in Lima VMs. Each runs Pebble,
# Let's Encrypt's test ACME server, which passes every challenge, so certificates
# come for chat.zuna.test, which each VM's hosts file points at the VM itself.
# What's checked is this checkout's HEAD, with deploy/ as it is now. Needs limactl
# and expect, and makes the VMs the first time, which takes a few minutes.
#
#   deploy/test/install-check.sh                 every scenario
#   deploy/test/install-check.sh caddy ip        some of them
#   deploy/test/install-check.sh --delete        delete the VMs
#
# Scenarios:
#   caddy     Debian, nothing on 80 and 443: installs Caddy, which gets the certificate
#   manual    Debian, with Caddy: driven by keys, setting the proxy up by hand, and
#             the check failing until the site is there
#   update    Debian: run again where Zuna is, which updates it
#   prompts   Debian: Ctrl+C at a question, and no terminal
#   certbot   Ubuntu, with nginx: adds a site, with a certificate from certbot
#   apache    Fedora, with Apache, firewalld and SELinux: adds a site, with certbot
#   ip        Fedora, by IP address: the server's own certificate, by its pin
#   relay     Fedora: deploy/install-relay.sh, the push relay alone, driven by keys,
#             then again, which offers to update it, and where a chat server is
set -euo pipefail

SRC="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(mktemp -d)"
DOMAIN=chat.zuna.test
PEBBLE=v2.10.1
ACME=(ZUNA_INSTALL_ACME_CA=https://localhost:14000/dir ZUNA_INSTALL_ACME_ROOT=/opt/pebble/certs/pebble.minica.pem)
ALL=(caddy manual update prompts certbot apache ip relay)

command -v limactl >/dev/null || { echo "This needs Lima: brew install lima" >&2; exit 1; }
command -v expect >/dev/null || { echo "This needs expect." >&2; exit 1; }

machine() {
  case "$1" in
    caddy | manual | update | prompts) echo debian ;;
    certbot) echo ubuntu ;;
    apache | ip | relay) echo fedora ;;
  esac
}
template() {
  case "$1" in debian) echo debian-13 ;; ubuntu) echo ubuntu-24.04 ;; fedora) echo fedora-43 ;; esac
}

case "${1:-}" in
  -h | --help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac
if [ "${1:-}" = --delete ]; then
  for name in debian ubuntu fedora; do limactl delete -f "zuna-install-$name" 2>/dev/null || true; done
  exit 0
fi
WANTED=("$@")
[ ${#WANTED[@]} -gt 0 ] || WANTED=("${ALL[@]}")
for scenario in "${WANTED[@]}"; do
  [ -n "$(machine "$scenario")" ] || { echo "No scenario called $scenario. See --help." >&2; exit 1; }
done

# Runs a command as root in a VM.
in_vm() {
  local name="$1"
  shift
  limactl shell --workdir / "zuna-install-$name" -- sudo "$@"
}

# The VM, made and started if it has to be, with Pebble trusted, git, and the domain.
ready() {
  local name="$1"
  if ! limactl list -q 2>/dev/null | grep -qx "zuna-install-$name"; then
    limactl create --name "zuna-install-$name" --tty=false --cpus 4 --memory 4 --disk 20 "template:$(template "$name")" >/dev/null
  fi
  limactl start --tty=false "zuna-install-$name" >/dev/null 2>&1 || true
  in_vm "$name" sh -s "$PEBBLE" "$DOMAIN" <<'EOF'
set -eu
version="$1" domain="$2"
if command -v apt-get >/dev/null; then pkg="apt-get install -y -q"; else pkg="dnf install -y -q"; fi
command -v git >/dev/null || { command -v apt-get >/dev/null && apt-get update -q; $pkg git; } >/dev/null 2>&1
git config --global --get-all safe.directory | grep -qx '\*' || git config --global --add safe.directory '*'
grep -q " $domain\$" /etc/hosts || echo "$(ip -4 -o addr show scope global | awk '{ split($4, a, "/"); print a[1]; exit }') $domain" >>/etc/hosts
if [ ! -x /usr/local/bin/pebble ]; then
  arch=arm64
  [ "$(uname -m)" = x86_64 ] && arch=amd64
  raw="https://raw.githubusercontent.com/letsencrypt/pebble/$version"
  mkdir -p /opt/pebble/certs/localhost
  curl -fsSL "https://github.com/letsencrypt/pebble/releases/download/$version/pebble-linux-$arch.tar.gz" | tar -xz -C /opt/pebble
  install -m 0755 "$(find /opt/pebble -name pebble -type f | head -n1)" /usr/local/bin/pebble
  curl -fsSL "$raw/test/certs/pebble.minica.pem" -o /opt/pebble/certs/pebble.minica.pem
  curl -fsSL "$raw/test/certs/localhost/cert.pem" -o /opt/pebble/certs/localhost/cert.pem
  curl -fsSL "$raw/test/certs/localhost/key.pem" -o /opt/pebble/certs/localhost/key.pem
  cat >/opt/pebble/config.json <<'J'
{"pebble": {"listenAddress": "0.0.0.0:14000", "managementListenAddress": "0.0.0.0:15000",
  "certificate": "/opt/pebble/certs/localhost/cert.pem", "privateKey": "/opt/pebble/certs/localhost/key.pem",
  "httpPort": 80, "tlsPort": 443, "ocspResponderURL": "", "externalAccountBindingRequired": false}}
J
  cat >/etc/systemd/system/pebble.service <<'U'
[Unit]
Description=Pebble, a test ACME server
[Service]
Environment=PEBBLE_VA_ALWAYS_VALID=1 PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0 PEBBLE_AUTHZREUSE=100
ExecStart=/usr/local/bin/pebble -config /opt/pebble/config.json
[Install]
WantedBy=multi-user.target
U
  systemctl daemon-reload
fi
# Pebble makes a new root each time it starts, so it's trusted afresh.
if ! systemctl is-active --quiet pebble; then
  systemctl enable --now --quiet pebble
  for _ in $(seq 1 30); do curl -fsk https://localhost:15000/roots/0 -o /opt/pebble/certs/root.pem && break; sleep 1; done
  if [ -d /usr/local/share/ca-certificates ]; then
    cp /opt/pebble/certs/root.pem /usr/local/share/ca-certificates/pebble-root.crt
    cp /opt/pebble/certs/pebble.minica.pem /usr/local/share/ca-certificates/pebble-minica.crt
    update-ca-certificates >/dev/null 2>&1
  else
    cp /opt/pebble/certs/root.pem /etc/pki/ca-trust/source/anchors/pebble-root.pem
    cp /opt/pebble/certs/pebble.minica.pem /etc/pki/ca-trust/source/anchors/pebble-minica.pem
    update-ca-trust
  fi
fi
EOF
}

# Zuna off the VM, with the sites the installer added to proxies, leaving the proxies,
# and /opt/zuna afresh from this checkout.
fresh() {
  local name="$1"
  in_vm "$name" sh -s <<'EOF'
systemctl disable --now --quiet zuna zuna-livekit 2>/dev/null
rm -f /etc/systemd/system/zuna.service /etc/systemd/system/zuna-livekit.service /usr/local/sbin/zuna-update
rm -rf /etc/zuna /var/lib/zuna /var/log/zuna-install.log
rm -f /usr/local/bin/zuna-server /usr/local/bin/zuna-server.previous /usr/local/bin/livekit-server /usr/local/bin/livekit-server.previous
if [ -f /etc/caddy/Caddyfile ]; then
  rm -f /etc/caddy/Caddyfile.d/zuna.caddyfile
  sed -i '/^# Zuna, added by deploy/d; /zuna\.caddyfile$/d' /etc/caddy/Caddyfile
  systemctl reload caddy 2>/dev/null
fi
rm -f /etc/nginx/sites-enabled/zuna.conf /etc/nginx/sites-available/zuna.conf /etc/nginx/conf.d/zuna.conf
rm -f /etc/apache2/sites-enabled/zuna.conf /etc/apache2/sites-available/zuna.conf /etc/httpd/conf.d/zuna.conf
systemctl reload nginx 2>/dev/null; systemctl reload apache2 2>/dev/null; systemctl reload httpd 2>/dev/null
systemctl daemon-reload
EOF
  checkout "$name"
}
checkout() {
  COPYFILE_DISABLE=1 tar --no-xattrs -C "$SRC" -cf - deploy 2>/dev/null |
    in_vm "$1" sh -c "rm -rf /opt/zuna && git clone -q '$SRC' /opt/zuna && tar --no-same-owner -C /opt/zuna -xf - 2>/dev/null"
}

# Runs the installer with OPTIONS, keeping what it printed. ACME is used when given.
install_with() {
  local name="$1" log="$2"
  shift 2
  in_vm "$name" env "${ACME[@]}" /opt/zuna/deploy/install.sh "$@" >"$log" 2>&1
}

# Whether the run ended with the server answering, WebSockets and voice included.
answered() {
  grep -q "Zuna answers at $1, with WebSockets and voice" "$2"
}

# --- Scenarios. Each prints what went wrong, if anything. ---

scenario_caddy() {
  local log="$OUT/caddy.log"
  fresh debian
  in_vm debian sh -c 'apt-get purge -y -q caddy nginx >/dev/null 2>&1; rm -f /etc/caddy/Caddyfile' || true
  install_with debian "$log" --domain "$DOMAIN" --proxy auto --yes || { echo "the installer failed"; return; }
  answered "https://$DOMAIN" "$log" || { echo "the server didn't answer through Caddy"; return; }
  in_vm debian grep -q '^import /etc/caddy/Caddyfile.d/zuna.caddyfile' /etc/caddy/Caddyfile || echo "the Caddyfile doesn't import Zuna's site"
  in_vm debian grep -q '^  node_ip: ' /etc/zuna/livekit.yaml || echo "LiveKit wasn't given this machine's address"
  in_vm debian test -x /usr/local/sbin/zuna-update || echo "there's no zuna-update"
}

scenario_manual() {
  local log="$OUT/manual.log" script="$OUT/manual.exp"
  fresh debian
  in_vm debian sh -c 'apt-get install -y -q caddy >/dev/null 2>&1; systemctl start caddy'
  cat >"$script" <<EOF
set timeout 30
log_file -noappend $log
spawn limactl shell --workdir / zuna-install-debian -- sudo env TERM=xterm-256color ${ACME[*]} /opt/zuna/deploy/install.sh
expect "By its IP address"
sleep 0.3; send "\r"
expect "Domain:"
sleep 0.3; send "$DOMAIN\r"
expect "shows what to add"
sleep 0.3; send "\r"
expect "On another machine"
sleep 0.3; send "\r"
expect "Change something"
sleep 0.3; send "\r"
set timeout 600
expect "Press Enter once"
sleep 0.5; send "\r"
set timeout 120
expect "Check again"
exec limactl shell --workdir / zuna-install-debian -- sudo sh -c {mkdir -p /etc/caddy/Caddyfile.d && cp /etc/zuna/proxy/caddy.conf /etc/caddy/Caddyfile.d/zuna.caddyfile && echo 'import /etc/caddy/Caddyfile.d/zuna.caddyfile' >>/etc/caddy/Caddyfile && systemctl reload caddy && sleep 8}
sleep 0.3; send "\r"
expect {
  "Check again" { exec sleep 5; send "\r"; exp_continue }
  "Back up" {}
}
expect eof
EOF
  expect "$script" >/dev/null 2>&1 || true
  grep -q "WebSockets on" "$log" || echo "there was no warning about WebSockets"
  grep -q "Not yet: nothing answers" "$log" || echo "the check didn't say what was wrong before the proxy was set up"
  answered "https://$DOMAIN" "$log" || echo "the server didn't answer once the site was added"
}

scenario_update() {
  local log="$OUT/update.log"
  in_vm debian test -f /etc/zuna/update.conf || scenario_caddy >/dev/null
  checkout debian
  in_vm debian /opt/zuna/deploy/install.sh --yes >"$log" 2>&1 || { echo "updating failed"; return; }
  grep -q "zuna is running" "$log" || echo "the server wasn't restarted"
  in_vm debian zuna-update --no-pull >>"$log" 2>&1 || echo "zuna-update failed"
}

scenario_prompts() {
  local log="$OUT/prompts.log" script="$OUT/prompts.exp"
  checkout debian
  cat >"$script" <<EOF
set timeout 30
log_file -noappend $log
spawn limactl shell --workdir / zuna-install-debian -- sudo env TERM=xterm-256color /opt/zuna/deploy/install.sh --dry-run
expect "Quit"
sleep 0.3; send "\003"
expect eof
EOF
  expect "$script" >/dev/null 2>&1 || true
  grep -q "Stopped. Nothing was changed." "$log" || echo "Ctrl+C didn't say that nothing changed"
  grep -qF $'\e[?25h' "$log" || echo "the cursor wasn't shown again"
  in_vm debian sh -c 'setsid /opt/zuna/deploy/install.sh </dev/null' >>"$log" 2>&1 && echo "it ran without a terminal"
  grep -q "it needs a terminal" "$log" || echo "without a terminal, it didn't say it needs one"
}

scenario_certbot() {
  local log="$OUT/certbot.log"
  fresh ubuntu
  in_vm ubuntu sh -c 'apt-get install -y -q nginx >/dev/null 2>&1; rm -rf /etc/letsencrypt/live/chat.zuna.test /etc/letsencrypt/archive/chat.zuna.test /etc/letsencrypt/renewal/chat.zuna.test.conf; systemctl start nginx'
  install_with ubuntu "$log" --domain "$DOMAIN" --proxy auto --yes || { echo "the installer failed"; return; }
  grep -q "Getting a certificate from Let's Encrypt" "$log" || echo "certbot wasn't used"
  answered "https://$DOMAIN" "$log" || echo "the server didn't answer through nginx"
  in_vm ubuntu grep -q 'systemctl reload nginx' "/etc/letsencrypt/renewal/$DOMAIN.conf" || echo "renewals won't reload nginx"
}

scenario_apache() {
  local log="$OUT/apache.log"
  fresh fedora
  # Without mod_ssl, whose settings name a certificate Fedora makes only when Apache starts.
  in_vm fedora sh -c 'dnf remove -y -q mod_ssl caddy nginx >/dev/null 2>&1; rm -f /etc/pki/tls/certs/localhost.crt /etc/pki/tls/private/localhost.key; dnf install -y -q httpd firewalld >/dev/null 2>&1; systemctl enable --now --quiet firewalld; systemctl enable --quiet httpd; systemctl restart httpd; setsebool httpd_can_network_relay 0'
  install_with fedora "$log" --domain "$DOMAIN" --proxy auto --yes || { echo "the installer failed"; return; }
  grep -q "Letting Apache reach Zuna" "$log" || echo "SELinux wasn't told to let Apache connect"
  answered "https://$DOMAIN" "$log" || echo "the server didn't answer through Apache"
  in_vm fedora firewall-cmd --list-ports | grep -q 7882/udp || echo "firewalld wasn't opened for calls"
}

scenario_ip() {
  local log="$OUT/ip.log" address
  fresh fedora
  address="$(in_vm fedora sh -c "ip -4 -o addr show scope global | awk '{ split(\$4, a, \"/\"); print a[1]; exit }'")"
  install_with fedora "$log" --ip "$address" --yes || { echo "the installer failed"; return; }
  answered "https://$address:8443" "$log" || echo "the server didn't answer at its address, by its pin"
  grep -q "/invite/.*#pin=" "$log" || echo "the setup link has no pin"
}

scenario_relay() {
  local log="$OUT/relay.log" address
  # Where a chat server is, it's update.sh's to add the relay.
  fresh fedora
  in_vm fedora sh -c 'mkdir -p /etc/zuna && echo SERVER_DOMAIN=\"chat.example.com\" >/etc/zuna/update.conf'
  relay_keys "$OUT/relay-server.log" "" ""
  grep -q "runs a chat server" "$OUT/relay-server.log" || echo "it didn't turn down a machine with a chat server"
  fresh fedora
  # A key in the APNs key's format, which Apple would turn down, so the relay starts but can't push.
  in_vm fedora sh -c 'openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out /root/AuthKey_ABC123DEFG.p8 2>/dev/null'
  relay_keys "$log" "push.zuna.test" "/root/AuthKey_ABC123DEFG.p8"
  grep -q "Its Key ID, from its name: ABC123DEFG" "$log" || echo "the Key ID wasn't taken from the file's name"
  grep -q "zuna-push is running" "$log" || { echo "the relay didn't start"; return; }
  address="$(in_vm fedora sh -c "ip -4 -o addr show scope global | awk '{ split(\$4, a, \"/\"); print a[1]; exit }'")"
  in_vm fedora curl -fs -o /dev/null "http://$address:8090/healthz" || echo "the relay doesn't answer at $address:8090"
  in_vm fedora grep -q '^ZUNA_PUSH_APNS_KEY_ID=ABC123DEFG$' /etc/zuna/push.env || echo "the relay wasn't given the Key ID"
  in_vm fedora test ! -e /etc/systemd/system/zuna.service || echo "a chat server was installed too"
  relay_keys "$OUT/relay-again.log" "" ""
  grep -q "set up here already, at push.zuna.test" "$OUT/relay-again.log" || echo "running it again didn't offer to update"
}
# Runs install-relay.sh, answering with a domain and key, or with n to whatever it asks first.
relay_keys() {
  local log="$1" domain="$2" key="$3" script="$OUT/relay.exp"
  cat >"$script" <<EOF
set timeout 30
log_file -noappend $log
spawn limactl shell --workdir / zuna-install-fedora -- sudo /opt/zuna/deploy/install-relay.sh
if {"$domain" eq ""} {
  expect {
    "Update it?" { send "n\r" }
    eof {}
  }
  expect eof
  exit
}
expect "domain:"
send "$domain\r"
expect ".p8 file:"
send "$key\r"
expect "listen on"
send "\r"
expect "Set it up?"
send "\r"
set timeout 600
expect eof
EOF
  expect "$script" >/dev/null 2>&1 || true
}

# Each VM's scenarios run in turn, and the VMs side by side.
run_machine() {
  local name="$1" scenario problems
  shift
  ready "$name" >"$OUT/ready-$name.log" 2>&1 || { echo "  FAILED to get the $name VM ready: $OUT/ready-$name.log"; return; }
  for scenario in "$@"; do
    problems="$("scenario_$scenario" 2>&1)" || true
    if [ -z "$problems" ]; then
      echo "  ok      $scenario"
    else
      echo "  FAILED  $scenario: ${problems//$'\n'/; } ($OUT/$scenario.log)"
    fi
  done
}

echo "Checking the installer, with logs in $OUT"
pids=()
for name in debian ubuntu fedora; do
  mine=()
  for scenario in "${ALL[@]}"; do
    [ "$(machine "$scenario")" = "$name" ] && [[ " ${WANTED[*]} " == *" $scenario "* ]] && mine+=("$scenario")
  done
  [ ${#mine[@]} -gt 0 ] || continue
  run_machine "$name" "${mine[@]}" >"$OUT/result-$name.txt" &
  pids+=($!)
done
for pid in "${pids[@]}"; do wait "$pid"; done
cat "$OUT"/result-*.txt
! grep -q FAILED "$OUT"/result-*.txt
