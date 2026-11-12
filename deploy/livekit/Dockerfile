# LiveKit's server, built from its commit with Zuna's patch by build.sh, which keeps what it
# learns about the people who join out of its log. The same golang image as server/Dockerfile.
FROM golang:1.26-alpine@sha256:a2012b4a1d1f9f7e9f44e0d39b805a901e856b1dd80b4e6ee4338db547050308 AS build
RUN apk add --no-cache git
COPY version zuna.patch build.sh /src/
RUN sh /src/build.sh /livekit-server

# The compose files' entrypoint needs /bin/sh and sed beside /livekit-server.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
COPY --from=build /livekit-server /livekit-server
ENTRYPOINT ["/livekit-server"]
