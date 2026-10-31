// Test harness: a real Go server plus real clients, in-memory local databases.

import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initCryptoSync, randomBytes } from "@zuna/crypto";
import { ZunaClient } from "../src/client";
import type { DbProvider, LocalDb, SqlValue } from "../src/db";
import type { CoreEvent } from "../src/types";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function loadCrypto(): void {
  initCryptoSync({ module: readFileSync(join(root, "packages", "crypto", "pkg", "zuna_crypto_bg.wasm")) });
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
    this.db.prepare(sql).run(...(params as never[]));
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
  execFileSync("go", ["build", "-o", out, "./cmd/zuna-server"], {
    cwd: join(root, "server"),
    env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
    stdio: "inherit",
  });
  return out;
}

export class TestServer {
  url = "";
  setupLink = "";
  private process: ChildProcess | null = null;
  private dir = "";

  /** `pushRelays` are the relays the server may send notifications through. */
  constructor(private readonly options: { pushRelays?: string[] } = {}) {}

  async start(): Promise<void> {
    const binary = buildServer();
    this.dir = mkdtempSync(join(tmpdir(), "zuna-test-"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    this.url = `http://127.0.0.1:${port}`;
    const args = ["--listen", `127.0.0.1:${port}`, "--data", this.dir, "--public-url", this.url, "--auth-burst", "1000"];
    // Never the project's real relay, which is the default.
    args.push("--push-relays", this.options.pushRelays?.join(",") || "off");
    this.process = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    this.process.stdout!.on("data", (chunk) => (output += chunk));
    this.process.stderr!.on("data", (chunk) => (output += chunk));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const match = output.match(/http:\/\/\S+\/invite\/\S+/);
      if (match) {
        this.setupLink = match[0];
        const ready = await fetch(`${this.url}/healthz`).then((r) => r.ok).catch(() => false);
        if (ready) return;
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

/** One app install, with its own device key and local databases. */
export class TestApp {
  readonly db: MemoryDbProvider;
  readonly deviceKey: Uint8Array;
  readonly events: CoreEvent[] = [];
  client!: ZunaClient;
  serverId = "";

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
