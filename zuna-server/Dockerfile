# ---- Build Stage ----
FROM golang:1.26-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o zuna-server .

# ---- Runtime Stage ----
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /build/zuna-server ./zuna-server

# Bundle default logo so the server has something to reference on first boot.
# Users can override it by placing their own logo at /data/logo.png and
# updating logo = '/data/logo.png' in config.toml.
COPY logo.png ./default_logo.png

# Persistent state (config, DB, keypair, TLS certs, attachments) lives here.
VOLUME ["/data"]

EXPOSE 8080

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
