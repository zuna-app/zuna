# A small image holding one static binary. It needs nothing but a data volume, and
# with voice channels a volume for the key it shares with LiveKit.
FROM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /zuna-server ./cmd/zuna-server
RUN mkdir -p /out/data /out/livekit && chown -R 65532:65532 /out/data /out/livekit

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /zuna-server /zuna-server
COPY --from=build --chown=65532:65532 /out/data /data
# A volume here starts out this account's, so it can make the key file in it.
COPY --from=build --chown=65532:65532 /out/livekit /livekit
ENV ZUNA_DATA=/data
VOLUME /data
EXPOSE 80 443 9660
ENTRYPOINT ["/zuna-server"]
