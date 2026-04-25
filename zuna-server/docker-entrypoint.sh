#!/bin/sh
set -e

DATA_DIR="/data"

_lk_key="${LIVEKIT_API_KEY:-}"
_lk_secret="${LIVEKIT_API_SECRET:-}"
_lk_host="${LIVEKIT_HOST:-localhost}"
_lk_port="${LIVEKIT_PORT:-7880}"
_lk_enabled=false
if [ -n "$_lk_key" ]; then
  _lk_enabled=true
fi

_db_host="${MYSQL_HOST:-127.0.0.1}"
_db_port="${MYSQL_PORT:-3306}"
_db_user="${MYSQL_USER:-zuna}"
_db_password="${MYSQL_PASSWORD:-zunapass}"
_db_name="${MYSQL_DATABASE:-zuna}"

_tls_public_address="${TLS_PUBLIC_ADDRESS:-127.0.0.1}"
_tls_auto_generate="${TLS_AUTO_GENERATE:-true}"

_server_id=""
if [ -z "$_server_id" ] && [ -r /proc/sys/kernel/random/uuid ]; then
  _server_id="$(tr -d '-' < /proc/sys/kernel/random/uuid)"
fi

mkdir -p "$DATA_DIR/storage_data"

if [ ! -f "$DATA_DIR/logo.png" ]; then
  cp /app/default_logo.png "$DATA_DIR/logo.png"
fi

if [ ! -f "$DATA_DIR/config.toml" ]; then
  echo "[entrypoint] No config.toml found — writing defaults to $DATA_DIR/config.toml"
  cat > "$DATA_DIR/config.toml" << EOF
# ── Database ─────────────────────────────────────────────────────────────────
database_type = 'mysql'

[sqlite]
database = '/data/zuna'   # .db extension is appended automatically

[mysql]
Host = '${_db_host}'
Port = ${_db_port}
Username = '${_db_user}'
Password = '${_db_password}'
Database = '${_db_name}'
parameters = ['parseTime=true']

# ── Server ───────────────────────────────────────────────────────────────────
[server]
bind_address = '0.0.0.0'
port = 25510
# Set a non-empty password to require it on /api/auth/join
password = ''
name = 'Zuna Server'
logo = '/data/logo.png'
storage_directory = '/data/storage_data'
# do not change this!
server_id = '${_server_id}'

# ── Limits ───────────────────────────────────────────────────────────────────
[limits]
min_username_length = 3
max_username_length = 32
max_message_size = 8192
max_avatar_size = 5242880
max_attachment_size = 536870912

# ── TLS ──────────────────────────────────────────────────────────────────────
[tls]
# auto_generate = true produces a self-signed certificate on first boot.
# For production set auto_generate = false and supply cert_file / key_file.
auto_generate = ${_tls_auto_generate}
public_address = '${_tls_public_address}'
cert_file = '/data/server_tls_cert.pem'
key_file  = '/data/server_tls_key.pem'

# ── 7TV emotes ───────────────────────────────────────────────────────────────
[sevenTv]
enabled = true
emotes_set = 'global'

# ── Gateway (optional push notifications) ───────────────────────────────────
[gateway]
address = 'gateway.zuna.chat'
password = '0cTriEzbSi34XYc62zXMVCPEd9qkDSXJ'
allow_self_signed = false

# ── LiveKit (optional calls / screen share) ──────────────────────────────────
[livekit]
enabled = ${_lk_enabled}
api_key = '${_lk_key}'
api_secret = '${_lk_secret}'
url = '${_lk_host}'
port = ${_lk_port}
EOF
fi

cd "$DATA_DIR"

exec /app/zuna-server "$@"
