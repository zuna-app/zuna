// The API a bot's code talks to: Telegram's Bot API over HTTP, on this machine alone.
// A library written for Telegram needs little more than this address in place of
// api.telegram.org, and the token from the bot's data folder.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import type { Bot } from "./bot";
import { ApiFailure, type Params } from "./params";

/** The most a call may carry: a file as large as a server could ever allow would be refused by it anyway. */
const LARGEST_BODY = 2 * 1024 ** 3;

export interface Served {
  port: number;
  close(): Promise<void>;
}

const same = (a: string, b: string): boolean => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

function answer(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

function refuse(response: ServerResponse, failure: ApiFailure): void {
  answer(response, failure.code, { ok: false, error_code: failure.code, description: failure.message, ...(failure.parameters ? { parameters: failure.parameters } : {}) });
}

/** What a call came with, from wherever it put it: the address, a form, JSON, or multipart with files. */
async function readParams(request: IncomingMessage, url: URL): Promise<Params> {
  const params: Params = Object.fromEntries(url.searchParams);
  if (request.method !== "POST") return params;
  if (Number(request.headers["content-length"] ?? 0) > LARGEST_BODY) throw new ApiFailure(413, "Request Entity Too Large");
  const type = request.headers["content-type"] ?? "";
  const body = new Response(Readable.toWeb(request) as ReadableStream, { headers: { "content-type": type } });
  try {
    if (type.startsWith("application/json")) {
      const parsed: unknown = await body.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(params, parsed);
    } else if (type.startsWith("multipart/form-data") || type.startsWith("application/x-www-form-urlencoded")) {
      const form = await body.formData();
      for (const [name, value] of form) params[name] = value;
      // A file may be named by another field, as attach://name says.
      for (const [name, value] of Object.entries(params)) {
        const attached = typeof value === "string" && value.startsWith("attach://") ? form.get(value.slice(9)) : null;
        if (attached) params[name] = attached;
      }
    } else {
      await body.arrayBuffer();
    }
  } catch (error) {
    if (error instanceof ApiFailure) throw error;
    throw new ApiFailure(400, "Bad Request: the request couldn't be read");
  }
  return params;
}

/**
 * Serves a bot's API, on this machine alone unless told otherwise. Each call names the
 * bot's token in its path, as Telegram's do: /bot<token>/<method>.
 */
export function serve(bot: Bot, options: { host?: string; port?: number } = {}): Promise<Served> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://zuna-bot");
      const method = /^\/bot([^/]+)\/([A-Za-z_]+)\/?$/.exec(url.pathname);
      const file = /^\/file\/bot([^/]+)\/files\/([0-9a-f]+)(?:\/.*)?$/.exec(url.pathname);
      const token = decodeURIComponent((method ?? file)?.[1] ?? "");
      try {
        if (!method && !file) throw new ApiFailure(404, "Not Found");
        if (!same(token, bot.token)) throw new ApiFailure(401, "Unauthorized");
        if (file) {
          const found = await bot.download(file[2]!);
          if (!found) throw new ApiFailure(404, "Not Found: file not found");
          const bytes = Buffer.from(await found.blob.arrayBuffer());
          response.writeHead(200, { "Content-Type": found.file.mime || "application/octet-stream", "Content-Length": bytes.length });
          response.end(bytes);
          return;
        }
        const result = await bot.call(method![2]!, await readParams(request, url));
        answer(response, 200, { ok: true, result });
      } catch (error) {
        // Whatever of the call wasn't read is let go of.
        request.resume();
        if (error instanceof ApiFailure) refuse(response, error);
        else {
          console.warn("[zuna-bot] a call failed:", error);
          refuse(response, new ApiFailure(500, "Internal Server Error"));
        }
      }
    })();
  });
  // A long poll waits for as long as it asked to, and a large file takes as long as it takes.
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8081, options.host ?? "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
