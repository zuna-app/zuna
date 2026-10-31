# A small image holding one static binary. It needs nothing but a data volume.
FROM golang:1.27-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=docker
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /zuna-server ./cmd/zuna-server
RUN mkdir -p /out/data && chown -R 65532:65532 /out/data

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /zuna-server /zuna-server
COPY --from=build --chown=65532:65532 /out/data /data
ENV ZUNA_DATA=/data
VOLUME /data
EXPOSE 80 443 8080
ENTRYPOINT ["/zuna-server"]
