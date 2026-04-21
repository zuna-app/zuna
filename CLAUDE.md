# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

Zuna is a fully self-hosted, end-to-end encrypted (E2EE) chat service. It's a monorepo with four main packages:

- **zuna-app**: Electron desktop client (React + TypeScript)
- **zuna-server**: Go backend with WebSocket support
- **zuna-gateway**: Optional Go WebSocket gateway for push notifications
- **zuna-cli**: Node.js terminal-based CLI client

## Build, Run, and Lint Commands

### zuna-app (Electron Desktop Client)

```bash
cd zuna-app

# Development
npm start              # Start dev server with Electron (hot reload)
npm run lint           # ESLint on .ts/.tsx files

# Packaging
npm run package        # Create platform-specific package
npm run make           # Build distributable binaries (Squirrel/DEB/RPM/ZIP)
npm run publish        # Publish to release channels
```

**Config files**: `forge.config.ts` (Electron Forge), `vite.renderer.config.ts` (Vite + React + Tailwind), `vite.main.config.ts`, `vite.preload.config.ts`

### zuna-server (Go Backend)

```bash
cd zuna-server

# Development
go run main.go         # Start server (default: localhost:8080)

# Build
go build               # Compile binary

# Database
# Migration is automatic on startup via Ent ORM (schema.Create)
```

**Config**: `config.toml` in the server directory. Supports SQLite (default, file: `zuna.db`) or MySQL. Change `database_type` and adjust credentials accordingly.

### zuna-gateway (Optional Gateway)

```bash
cd zuna-gateway

go run main.go         # Start gateway
go build               # Compile binary
```

### zuna-cli (Node.js CLI)

```bash
cd zuna-cli

npm start              # Run interactive CLI
# or directly: node index.js
```

Keys and server history persist in `~/.zuna-cli.json`.

## High-Level Architecture

### System Design

```
┌──────────────────┐
│   zuna-app       │ (Electron Desktop)
│ (React/TS)       ├─ WebSocket ──┬─ HTTP REST ──┐
└──────────────────┘              │              │
                                  v              v
                        ┌──────────────────────┐
                        │   zuna-server        │
                        │ (Go + Ent ORM)       │
                        │ :8080                │
                        │ SQLite/MySQL         │
                        └──────────────────────┘
                                  │
                                  v
                        ┌──────────────────────┐
                        │   zuna-gateway       │
                        │ (Optional WebSocket) │
                        │ For push notify      │
                        └──────────────────────┘

zuna-cli ─ HTTP/WebSocket ──→ zuna-server
```

### Core Patterns

**End-to-End Encryption**:
- All crypto (X25519 for DH, Ed25519 for signing, AES-GCM for messages) happens client-side
- Server stores only ciphertext; cannot decrypt messages
- Clients compute shared secrets and encrypt/decrypt locally

**Authentication Flow**:
1. Client requests handshake → server provides nonce
2. Client signs nonce with Ed25519 private key (offline)
3. Client posts signature → server verifies → issues JWT token
4. WebSocket connects with token; server adds client to chat hubs

**Message Delivery**:
- REST: `/api/chat/list` (other users), `/api/chat/messages` (paginated history)
- WebSocket: Real-time delivery via Hub (broadcast-style per chat room)
- Rate limiting: Auth endpoints strict (10 req/min per IP), general API more lenient (120 req/min per IP)

**Storage**:
- Client: Scrypt-derived vault password locks keys in in-memory Electron safe storage
- Server: Ent ORM schema with auto-migrations; Users, Chats, Messages, Attachments

### Key Source Entry Points

| Package | Entry Point | Purpose |
|---------|-------------|---------|
| zuna-app | `src/main.ts` | Electron main process; IPC registration |
| zuna-app | `src/preload.ts` | Security boundary; exposes IPC channels to renderer |
| zuna-app | `src/ipc.ts` | All IPC handler implementations (crypto, vault, window) |
| zuna-app | `src/app/App.tsx` | Root: manages auth state, server selection, chat routing |
| zuna-app | `src/hooks/ws/` | WebSocket connection + all incoming message type handlers |
| zuna-server | `main.go` | Echo route registration, WS hub init, DB migration |
| zuna-server | `ws/ws_hub.go` | Client registry and broadcast logic |
| zuna-server | `ent/schema/` | Authoritative DB schema (Ent entity definitions) |

## Frameworks & Libraries

### Frontend (zuna-app)

| Layer | Choice |
|-------|--------|
| **Runtime** | Electron 41.2.0 |
| **UI** | React 19 + TypeScript 4.5 |
| **Styling** | Tailwind CSS 4 + Shadcn/Radix UI |
| **State** | Jotai (atoms) |
| **Data Fetching** | TanStack React Query 5 |
| **Crypto** | Tweetnacl.js (X25519, Ed25519), AES-GCM, Scrypt |
| **WebSocket** | react-use-websocket |
| **Build** | Vite 8 + Electron Forge 7 |
| **Linting** | ESLint 8 + TypeScript ESLint 5 |

**Key IPC Handlers** (in `src/ipc.ts`):
- **Crypto**: `file:encrypt/decrypt`, `x25519:*`, `ed25519:*`, `base64:*`
- **Storage**: `vault:get/set/delete/lock/unlock/isFirstTimeSetup/import`
- **Window**: `window:minimize/maximize/close`
- **Network**: `og:fetch` (Open Graph meta), `shell:openExternal`

### Backend (zuna-server)

| Layer | Choice |
|-------|--------|
| **Language** | Go 1.26 |
| **Web** | Echo 5 |
| **ORM** | Ent (generates CRUD code) |
| **Database** | MySQL or SQLite (configurable) |
| **Logging** | Zerolog (JSON) |
| **Config** | go-toml v2 |
| **WebSocket** | gorilla/websocket |
| **Rate Limiting** | golang.org/x/time/rate (per-IP token-bucket) |
| **ID Generation** | cuid2 |

### Gateway & CLI

- **zuna-gateway**: Go + Echo + Gorilla WebSocket (minimal relay)
- **zuna-cli**: Node.js + ws library + tweetnacl.js (same crypto as app)

## Database & API

### Schema (Ent ORM)

```
User
├── id (CUID2)
├── username (unique)
├── identity_key (X25519 public, unique)
├── signing_key (Ed25519 public, unique)
├── last_seen, is_admin, avatar_mime, avatar_key
└── edges: chats, messages, attachments

Chat
├── id (CUID2)
└── edges: users (many-to-many), messages

Message
├── id (int64, auto-increment)
├── cipher_text (AES-GCM), iv, auth_tag
├── sent_at, read_at (nullable)
└── edges: user, chat, attachment (optional)

Attachment
├── id, file_key, mime_type, metadata
└── edges: message (one-to-one optional)
```

**Auto-migrations**: Schema created on server startup via `ent.Schema.Create(ctx)`

### REST Endpoints

**POST /api/auth/handshake** (10 req/min per IP)
- Request: `{username}`
- Response: `{nonce, server_name, server_logo, seven_tv_enabled, seven_tv_emotes_set}`

**POST /api/auth/login** (10 req/min per IP)
- Request: `{username, signature}`
- Response: `{token}` (JWT for WebSocket)

**POST /api/auth/join** (10 req/min per IP)
- Request: `{username, identity_key, signing_key, avatar, server_password}`
- Response: `{id}`
- Validates: username length 3-32, alphanumeric only, uniqueness, keys format

**GET /api/chat/list** (requires JWT, 120 req/min per IP)
- Response: Array of ChatMember (other users in your chats, with last message preview)

**GET /api/chat/messages** (requires JWT, 120 req/min per IP)
- Query: `chat_id`, `limit`, `cursor` (message ID for pagination)
- Response: `{messages: Message[]}`

**POST /api/attachment/upload** (requires JWT)
- Form data: file + attachment_metadata (encrypted filename)
- Response: `{attachment_id}`

**GET /api/attachment/download** (requires JWT)
- Query: `id`
- Response: binary (encrypted file; client decrypts with sender's identity key)

### WebSocket (`/ws`)

After POST /api/auth/login, connect to `/ws` with token in header or first message.

**Message Protocol** (JSON frames):

```json
{"type": "auth", "payload": {"token": "..."}}
{"type": "message", "payload": {"chat_id": "...", "cipher_text": "...", "iv": "...", "auth_tag": "...", "local_id": 1}}
{"type": "message_ack", "payload": {"local_id": 1, "id": 12345, "created_at": ...}}
{"type": "presence", "payload": {"status": "online|idle|offline"}}
{"type": "write_indicator", "payload": {"chat_id": "..."}}
{"type": "mark_read", "payload": {"chat_id": "...", "message_id": ...}}
```

## Configuration

### zuna-server: config.toml

```toml
database_type = 'sqlite'  # or 'mysql'

[sqlite]
database = 'zuna.db'

[mysql]
Host = '127.0.0.1'
Port = 3306
Username = 'root'
Password = ''
Database = 'zuna'

[server]
bind_address = '0.0.0.0'
port = 8080
password = 'test1234'              # Shared secret for /api/auth/join
name = 'Example Zuna server'
logo = 'logo.gif'                  # Embedded in /api/auth/handshake
storage_directory = 'storage_data' # For avatars & attachments

[limits]
min_username_length = 3
max_username_length = 32
max_message_size = 8192            # 8 KB
max_avatar_size = 5242880          # 5 MB
max_attachment_size = 536870912    # 512 MB

[sevenTv]
enabled = true
emotes_set = 'https://7tv.app/emote-sets/...'
```

### zuna-gateway: Similar structure

```toml
[gateway]
bind_address = '0.0.0.0'
port = 8080
password = ''  # Empty for public gateway
```

## Key Implementation Details

### Client Encryption Flow

1. **Key Generation**: On first setup, client generates Ed25519 (signing) and X25519 (encryption) key pairs offline
2. **Key Storage**: Private keys locked in Scrypt-derived vault (password-protected Electron safe storage)
3. **Message Encryption**: Client computes DH shared secret with recipient's X25519 public key → AES-GCM encrypt message → send ciphertext + IV + auth tag
4. **Message Decryption**: Reverse: retrieve sender's X25519 key from server → compute shared secret → AES-GCM decrypt
5. **File Encryption**: Similar; attachments encrypted before upload, decrypted after download

### Server Storage

- Messages stored as `(cipher_text, iv, auth_tag)` tuples; server never decrypts
- Avatar stored with CUID2-generated key; MIME type stored for display
- File attachments similarly keyed; metadata (filename) encrypted client-side

### Performance Optimizations

- React virtualization for large message lists (`react-virtualized`)
- Blob URL LRU cache for attachments (max 100 entries)
- SQLite WAL mode for concurrent read/write
- Per-IP rate limiter evicts stale entries every TTL/2
- TanStack Query for smart HTTP caching & deduplication

### Security Considerations

- Electron preload enforces context isolation; only IPC can access Node APIs
- Rate limiting tighter on auth endpoints (crypto expensive)
- Strict JSON binder validates all request fields
- CORS open for all origins (self-hosted, trusted environment)
- No password sent to server; only signature of server-provided nonce

## Testing & Development Notes

- **No test suite visible** in the repository (likely early-stage project)
- **No CI/CD config** (no GitHub Actions, etc.)
- **Linting**: `npm run lint` in zuna-app only; Go code unformatted
- **Database**: Auto-migrations on startup; inspect `zuna.db` with SQLite CLI if needed
- **Debugging**:
  - zuna-app: DevTools open in Electron window; breakpoints in React components
  - zuna-server: Zerolog output to stderr (JSON); adjust log level in code if needed
  - zuna-cli: stderr for debug output
