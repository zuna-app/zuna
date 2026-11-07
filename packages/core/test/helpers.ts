// Test harness: a real Go server plus real clients, in-memory local databases.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";
import { initCryptoSync, randomBytes } from "@zuna/crypto";
import { ZunaClient } from "../src/client";
import type { DbProvider, LocalDb, SqlValue } from "../src/db";
import { toBase64 } from "../src/encoding";
import { allowLocalLinks, type WebAdapter } from "../src/links";
import { rotationTiming } from "../src/session";
import type { CoreEvent } from "../src/types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function loadCrypto(): void {
  initCryptoSync({ module: readFileSync(join(root, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm")) });
  // Tests serve their pages from this machine, which a released app won't fetch.
  allowLocalLinks(true);
  // Nobody here has half a minute to wait for a device to take over a rotation.
  rotationTiming.gatherMs = 20;
  rotationTiming.takeoverMs = 200;
  rotationTiming.retryMs = 200;
}

class MemoryDb implements LocalDb {
  private depth = 0;
  constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}

  private convert<T>(row: T): T {
    if (!row || typeof row !== "object") return row;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as object)) {
      out[key] = value instanceof Uint8Array ? new Uint8Array(value) : value;
    }
    return out as T;
  }

  run(sql: string, params: SqlValue[] = []): void {
    if (params.length === 0) {
      this.db.exec(sql);
      return;
    }
    const statement = this.db.prepare(sql);
    // run() reports the last row added, and FTS5 numbers its own rows past 2^53, which only a BigInt holds.
    statement.setReadBigInts(true);
    statement.run(...(params as never[]));
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return (this.db.prepare(sql).all(...(params as never[])) as T[]).map((row) => this.convert(row));
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    const row = this.db.prepare(sql).get(...(params as never[])) as T | undefined;
    return row ? this.convert(row) : undefined;
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Databases stay in memory but survive a simulated app restart. Given a folder,
 * they're kept there instead and survive a real one.
 */
export class MemoryDbProvider implements DbProvider {
  private dbs = new Map<string, MemoryDb>();

  constructor(private readonly dir?: string) {}

  private path(name: string): string {
    return join(this.dir!, `${name}.db`);
  }

  async open(name: string): Promise<LocalDb> {
    let db = this.dbs.get(name);
    if (!db) {
      const raw = new DatabaseSync(this.dir ? this.path(name) : ":memory:");
      if (this.dir) raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;");
      db = new MemoryDb(raw);
      this.dbs.set(name, db);
    }
    return db;
  }

  async remove(name: string): Promise<void> {
    this.dbs.get(name)?.close();
    this.dbs.delete(name);
    if (this.dir) rmSync(this.path(name), { force: true });
  }
}

function deviceKeyIn(dir: string): Uint8Array {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "device-key");
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const key = randomBytes(32);
  writeFileSync(path, key);
  return key;
}

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);

function buildServer(): string {
  const out = join(tmpdir(), `zuna-test-server${process.platform === "win32" ? ".exe" : ""}`);
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "./cmd/zuna-server"], {
    cwd: join(root, "server"),
    env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
    stdio: "inherit",
  });
  return out;
}

/** Answers at all, whatever its certificate, which is for the apps to check. */
function healthy(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const get = url.startsWith("https:") ? httpsGet : httpGet;
    get(`${url}/healthz`, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    }).on("error", () => resolve(false));
  });
}

export class TestServer {
  url = "";
  setupLink = "";
  private process: ChildProcess | null = null;
  private dir = "";

  /**
   * `pushRelays` are the relays the server may send notifications through. `liveKit` is the media server voice channels would use.
   * `sqlite` keeps its database in SQLite even with ZUNA_TEST_POSTGRES, for tests that open it as a stolen backup or a malicious server would.
   * `ownCertificate` has it reached by its IP address, with a certificate it makes itself, which its links pin.
   * `presenceLinger` is how long, in ms, someone shows as online after they stop using an app, instead of a minute.
   */
  constructor(private readonly options: { pushRelays?: string[]; liveKit?: string; sqlite?: boolean; ownCertificate?: boolean; presenceLinger?: number } = {}) {}

  async start(): Promise<void> {
    const binary = buildServer();
    this.dir = mkdtempSync(join(tmpdir(), "zuna-test-"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    this.url = `${this.options.ownCertificate ? "https" : "http"}://127.0.0.1:${port}`;
    const args = ["--listen", `127.0.0.1:${port}`, "--data", this.dir, "--public-url", this.url, "--auth-burst", "1000"];
    if (this.options.ownCertificate) args.push("--domain", "127.0.0.1");
    // Never the project's real relay, which is the default.
    args.push("--push-relays", this.options.pushRelays?.join(",") || "off");
    // With ZUNA_TEST_POSTGRES, in a schema of its own in that PostgreSQL database, which the server makes.
    if (process.env.ZUNA_TEST_POSTGRES && !this.options.sqlite) {
      const database = new URL(process.env.ZUNA_TEST_POSTGRES);
      database.searchParams.set("search_path", `zuna_test_${crypto.randomUUID().replaceAll("-", "")}`);
      args.push("--database-url", database.toString());
    }
    if (this.options.liveKit) {
      // With its own certificate, apps reach LiveKit through the server's address, which its pin covers.
      const reached = this.options.ownCertificate ? ["--livekit-internal-url", this.options.liveKit.replace(/^ws/, "http")] : ["--livekit-url", this.options.liveKit];
      args.push(...reached, "--livekit-key", "key", "--livekit-secret", "a-long-enough-secret-for-signing-tokens");
    }
    const env = { ...process.env };
    if (this.options.presenceLinger) env.ZUNA_TEST_PRESENCE_LINGER = `${this.options.presenceLinger}ms`;
    this.process = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let output = "";
    this.process.stdout!.on("data", (chunk) => (output += chunk));
    this.process.stderr!.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const match = output.match(/https?:\/\/\S+\/invite\/\S+/);
      if (match) {
        this.setupLink = match[0];
        if (await healthy(this.url)) return;
      }
      await sleep(50);
    }
    throw new Error(`the server didn't start:\n${output}`);
  }

  async stop(): Promise<void> {
    this.process?.kill();
    await sleep(200);
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the database file open for a moment longer.
    }
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The pin of each server that makes its own certificate, by host and port. The last one given counts. */
const pins = new Map<string, string>();

/**
 * What the apps' hosts do with a server's pin, for Node's fetch and WebSocket: a
 * server with one is trusted by its key matching the pin, and by nothing else.
 */
function pinInNode(url: string, pin: string): void {
  const { hostname, port } = new URL(url);
  if (pins.size === 0) {
    const usual = buildConnector({});
    // A resumed session shows no certificate to check, so each connection starts afresh.
    const own = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
    setGlobalDispatcher(
      new Agent({
        connect(options, callback) {
          const wanted = pins.get(`${options.hostname}:${options.port || 443}`);
          if (!wanted || options.protocol !== "https:") return usual(options, callback);
          own(options, (error, socket) => {
            if (error || !socket) return callback(error ?? new Error("No connection."), null);
            const key = (socket as TLSSocket).getPeerX509Certificate()?.publicKey.export({ type: "spki", format: "der" });
            if (key && createHash("sha256").update(key).digest("base64url") === wanted) return callback(null, socket);
            socket.destroy();
            callback(new Error("The server's certificate doesn't match its pin."), null);
          });
        },
      }),
    );
  }
  pins.set(`${hostname}:${port || 443}`, pin);
}

/** One app install, with its own device key and local databases. */
export class TestApp {
  readonly db: MemoryDbProvider;
  readonly deviceKey: Uint8Array;
  readonly events: CoreEvent[] = [];
  client!: ZunaClient;
  serverId = "";
  /** How link previews fetch pages, if this app makes them. */
  web?: WebAdapter;
  /** Whether this app shows channels, as every app does. One that doesn't takes no part in them. */
  channels = true;
  /** Whether this app has calls in direct messages and groups. */
  calls = true;
  /** Whether this app can trust a server's own certificate by its pin, as a browser can't. */
  pinning = true;
  /** Each server it was asked to trust, and by which pin. */
  readonly pinned: [url: string, pin: string][] = [];

  /** Given a folder, the app keeps its data there and can be reopened by a later process. */
  constructor(
    readonly name: string,
    dir?: string,
  ) {
    this.db = new MemoryDbProvider(dir);
    this.deviceKey = dir ? deviceKeyIn(dir) : randomBytes(32);
  }

  async open(): Promise<this> {
    this.client = new ZunaClient({
      db: this.db,
      deviceKey: this.deviceKey,
      deviceName: this.name,
      onEvent: (event) => this.events.push(event),
      web: this.web,
      channels: this.channels,
      calls: this.calls,
      pinServer: this.pinning
        ? async (url, pin) => {
            this.pinned.push([url, pin]);
            pinInNode(url, pin);
          }
        : undefined,
    });
    await this.client.open();
    const first = this.client.listServers()[0];
    if (first) this.serverId = first.id;
    return this;
  }

  get session() {
    return this.client.session(this.serverId);
  }

  get userId() {
    return this.session.getSelf().userId;
  }

  async register(link: string, username: string, password = "correct horse battery"): Promise<string> {
    const preview = await this.client.previewInvite(link);
    const result = await this.client.register(preview, username, password, { displayName: username });
    this.serverId = result.serverId;
    await this.online();
    return result.recoveryKey;
  }

  async login(url: string, username: string, password = "correct horse battery"): Promise<void> {
    this.serverId = await this.client.login(url, username, password);
    await this.online();
  }

  async online(): Promise<void> {
    await waitFor(() => this.session.connectionState === "online", `${this.name} to come online`);
  }

  /** Restarts the app as if it had been closed and reopened. */
  async restart(): Promise<void> {
    this.client.stop();
    await sleep(50);
    await this.open();
    await this.online();
  }

  texts(groupKey: string): string[] {
    const group = this.session.getConversations().find((item) => item.key === groupKey);
    if (!group?.groupId) return [];
    return (this.session as any).db
      .all("SELECT id FROM messages WHERE group_id = ? AND seq IS NOT NULL ORDER BY seq", [group.groupId])
      .map((row: { id: string }) => (this.session as any).toMessageView((this.session as any).messageRow(group.groupId, row.id)))
      .filter((view: { system: unknown; deletedAt: unknown }) => !view.system && !view.deletedAt)
      .map((view: { text: string; status: string }) => (view.status === "sent" ? view.text : `<${view.status}>`));
  }
}

/** A PNG, solid as a page's picture would be, or with each pixel's color given. */
export function png(width: number, height: number, color?: (x: number, y: number) => [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "latin1");
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x7a);
  for (let row = 0; row < height; row++) {
    rows[row * (width * 3 + 1)] = 0;
    if (color) for (let x = 0; x < width; x++) rows.set(color(x, row), row * (width * 3 + 1) + 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/**
 * Link previews in Node: pages come from fetch, and pictures, which Node can't
 * shrink, are passed through when they're PNGs, with their size from the header.
 */
export const nodeWeb: WebAdapter = {
  async fetch(url, maxBytes) {
    const response = await fetch(url, { redirect: "follow" });
    const body = new Uint8Array(await response.arrayBuffer()).subarray(0, maxBytes);
    return { url: response.url, type: response.headers.get("content-type") ?? "", body };
  },
  async shrinkImage(body) {
    const png = [0x89, 0x50, 0x4e, 0x47].every((byte, index) => body[index] === byte);
    if (!png) return null;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    return { data: `data:image/png;base64,${toBase64(body)}`, width: view.getUint32(16), height: view.getUint32(20) };
  },
};

export async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = await condition();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A push relay that records what servers send it, for tests. */
export class FakeRelay {
  url = "";
  readonly pushes: { handle: string; data: { r: string; p: string }; collapse_id: string }[] = [];
  private server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (request.url === "/v1/push") this.pushes.push(JSON.parse(body));
      response.statusCode = 204;
      response.end();
    });
  });

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.server.close();
  }
}
