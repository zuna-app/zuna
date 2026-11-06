// Link previews connect through here, so the address a preview reaches is the one
// that was checked. Checking a name and then letting Chromium connect leaves a
// moment between the two, in which the name can come to lead to this machine or
// a private network. Chromium still does TLS end to end, so it checks the site's
// certificate as before: this only picks the address and passes bytes along.

import { lookup } from "node:dns/promises";
import { createServer, type IncomingMessage } from "node:http";
import { connect, isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { privateAddress } from "@zuna/core/links";

export interface PreviewProxy {
  /** The port on 127.0.0.1 it listens on. */
  port: number;
  close(): void;
}

type Resolve = (host: string) => Promise<string[]>;

const resolveAll: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Where a CONNECT for `target` may go: the one address it connects to, or null to
 * refuse. Only port 443, as previews only go there, and only when every address
 * the name leads to is public, as `safeToFetch` checks. `local` says which hosts a
 * development build may reach anyway, for its test pages.
 */
export async function previewDestination(target: string, local: (host: string) => boolean, resolve: Resolve = resolveAll): Promise<{ address: string; port: number } | null> {
  let url: URL;
  try {
    url = new URL(`https://${target}`);
  } catch {
    return null;
  }
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const port = url.port === "" ? 443 : Number(url.port);
  if (local(url.hostname)) return { address: host, port };
  if (port !== 443) return null;
  if (isIP(host)) return privateAddress(host) ? null : { address: host, port };
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return null;
  }
  if (addresses.length === 0 || addresses.some((address) => privateAddress(address))) return null;
  return { address: addresses[0]!, port };
}

export function startPreviewProxy(local: (host: string) => boolean, resolve: Resolve = resolveAll): Promise<PreviewProxy> {
  const server = createServer((_request, response) => {
    // Previews only fetch over HTTPS, which comes as CONNECT.
    response.writeHead(405).end();
  });
  server.on("connect", (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => client.destroy());
    void previewDestination(request.url ?? "", local, resolve).then((destination) => {
      if (!destination || client.destroyed) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      let connected = false;
      const upstream: Socket = connect(destination.port, destination.address, () => {
        connected = true;
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => {
        if (!connected && !client.destroyed) client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        else client.destroy();
      });
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
  });
  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveStart({ port: typeof address === "object" && address ? address.port : 0, close: () => server.close() });
    });
  });
}
