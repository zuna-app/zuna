// The API a bot's code talks to: Telegram's Bot API over HTTP, on this machine alone.
// A library written for Telegram needs little more than this address in place of
// api.telegram.org, and the token from the bot's data folder.

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Bot } from "./bot";
import { ApiFailure, type Params } from "./params";

/** The most a call may carry: a file as large as a server could ever allow would be refused by it anyway. */
const LARGEST_BODY = 2 * 1024 ** 3;

export interface Served {
  port: number;
  close(): Promise<void>;
}

const METHOD_RE = /^\/bot([^/]+)\/([A-Za-z_]+)\/?$/;
const FILE_RE = /^\/file\/bot([^/]+)\/files\/([0-9a-f]+)(?:\/.*)?$/;

async function readText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > LARGEST_BODY) throw new ApiFailure(413, "Request Entity Too Large");
    chunks.push(buf);
  }
  return chunks.length === 1 ? chunks[0]!.toString("utf8") : Buffer.concat(chunks, total).toString("utf8");
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  response.end(text);
}

function refuse(response: ServerResponse, failure: ApiFailure): void {
  answer(response, failure.code, { ok: false, error_code: failure.code, description: failure.message, ...(failure.parameters ? { parameters: failure.parameters } : {}) });
}

/** Which call a request is, from its address: a method or a file, and the token it named. */
function route(request: IncomingMessage): { url: URL; method: string | null; file: string | null; token: string } {
  const unreadable = () => new ApiFailure(400, "Bad Request: the address couldn't be read");
  let url: URL;
  try {
    url = new URL(request.url ?? "/", "http://zuna-bot");
  } catch {
    throw unreadable();
  }
  const method = METHOD_RE.exec(url.pathname);
  const file = method ? null : FILE_RE.exec(url.pathname);
  if (!method && !file) throw new ApiFailure(404, "Not Found");
  let token: string;
  try {
    token = decodeURIComponent((method ?? file)![1]!);
  } catch {
    throw unreadable();
  }
  return { url, method: method?.[2] ?? null, file: file?.[2] ?? null, token };
}

/** What a call came with, from wherever it put it: the address, a form, JSON, or multipart with files. */
async function readParams(request: IncomingMessage, url: URL): Promise<Params> {
  const params: Params = Object.fromEntries(url.searchParams);
  if (request.method !== "POST") return params;
  if (Number(request.headers["content-length"] ?? 0) > LARGEST_BODY) throw new ApiFailure(413, "Request Entity Too Large");
  const type = request.headers["content-type"] ?? "";
  try {
    if (type.startsWith("application/json")) {
      const parsed: unknown = JSON.parse(await readText(request));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) Object.assign(params, parsed);
    } else if (type.startsWith("application/x-www-form-urlencoded")) {
      const form = new URLSearchParams(await readText(request));
      for (const [name, value] of form) params[name] = value;
    } else if (type.startsWith("multipart/form-data")) {
      const body = new Response(Readable.toWeb(request) as ReadableStream, { headers: { "content-type": type } });
      const form = await body.formData();
      for (const [name, value] of form) params[name] = value;
      // A file may be named by another field, as attach://name says.
      for (const [name, value] of Object.entries(params)) {
        const attached = typeof value === "string" && value.startsWith("attach://") ? form.get(value.slice(9)) : null;
        if (attached) params[name] = attached;
      }
    } else {
      request.resume();
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
  const expectedTokenHash = createHash("sha256").update(bot.token).digest();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        // Nothing of the request is trusted before the token is checked, its address included,
        // so whatever it can't be read as is refused here, and never ends the process.
        const { url, method, file, token } = route(request);
        if (!timingSafeEqual(createHash("sha256").update(token).digest(), expectedTokenHash)) throw new ApiFailure(401, "Unauthorized");
        if (file) {
          const found = await bot.download(file);
          if (!found) throw new ApiFailure(404, "Not Found: file not found");
          response.writeHead(200, { "Content-Type": found.file.mime || "application/octet-stream", "Content-Length": found.blob.size });
          // Ends, and lets go of the file, when the bot's code hangs up halfway too.
          await pipeline(Readable.fromWeb(found.blob.stream() as Parameters<typeof Readable.fromWeb>[0]), response);
          return;
        }
        const result = await bot.call(method!, await readParams(request, url));
        answer(response, 200, { ok: true, result });
      } catch (error) {
        // Whatever of the call wasn't read is let go of.
        request.resume();
        // A file that stopped halfway can only be cut off.
        if (response.headersSent) response.destroy();
        else if (error instanceof ApiFailure) refuse(response, error);
        else {
          console.warn("[zuna-bot] a call failed:", error);
          refuse(response, new ApiFailure(500, "Internal Server Error"));
        }
      }
    })().catch((error: unknown) => {
      // Should answering itself ever fail, that ends this call alone.
      console.warn("[zuna-bot] a call couldn't be answered:", error);
      response.destroy();
    });
  });
  // A long poll waits for as long as it asked to, and a large file takes as long as it takes.
  server.requestTimeout = 0;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8081, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      // Once it listens, a connection it couldn't take, as when the process has no files left to
      // open, is said and let go of, and the API goes on.
      server.on("error", (error) => console.warn("[zuna-bot] the API couldn't take a connection:", error.message));
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
