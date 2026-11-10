// What the client core asks of whatever runs it, on a server: SQLite files in the bot's
// data folder, a device key in a file there, and trust in a server's own certificate by
// the pin its links carry.
//
// There's no keychain on a server, so the device key is a file only its user can read.
// Whoever copies the folder is the bot.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TLSSocket } from "node:tls";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";
import { initCryptoSync, randomBytes } from "@zuna/crypto";
import type { DbProvider, LocalDb, SqlValue } from "@zuna/core";

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

let cryptoLoaded = false;

/** Loads the cryptography, from beside the built program, or from where the repository builds it. */
export function loadCrypto(): void {
  if (cryptoLoaded) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const places = [join(here, "zuna_crypto_bg.wasm"), join(here, "..", "..", "..", "packages", "crypto", "pkg", "zuna_crypto_bg.wasm")];
  const found = places.find((path) => existsSync(path));
  if (!found) throw new Error("The cryptography isn't built. Run npm run build:crypto.");
  initCryptoSync({ module: readFileSync(found) });
  cryptoLoaded = true;
}

/** Writes a file only this user can read, which is all that keeps what's in it. */
export function writePrivate(path: string, data: string | Uint8Array): void {
  writeFileSync(path, data, { mode: 0o600 });
  // The mode above only counts for a file that wasn't there.
  try {
    chmodSync(path, 0o600);
  } catch {
    // A file system without modes, as on Windows, where the folder's own rights decide.
  }
}

/** Makes the bot's data folder, for this user alone. */
export function dataFolder(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

class DiskDb implements LocalDb {
  private depth = 0;

  constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}

  private convert<T>(row: T): T {
    if (!row || typeof row !== "object") return row;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as object)) out[key] = value instanceof Uint8Array ? new Uint8Array(value) : value;
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

/** The core's databases, as files in the bot's data folder. */
export class DiskDbProvider implements DbProvider {
  private dbs = new Map<string, DiskDb>();

  constructor(private readonly dir: string) {}

  private path(name: string): string {
    return join(this.dir, `${name}.db`);
  }

  async open(name: string): Promise<LocalDb> {
    let db = this.dbs.get(name);
    if (!db) {
      const raw = new DatabaseSync(this.path(name));
      raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      db = new DiskDb(raw);
      this.dbs.set(name, db);
    }
    return db;
  }

  async remove(name: string): Promise<void> {
    this.dbs.get(name)?.close();
    this.dbs.delete(name);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(this.path(name) + suffix, { force: true });
  }

  closeAll(): void {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }
}

/** The key the bot's data is sealed with on this machine, made the first time. */
export function deviceKey(dir: string): Uint8Array {
  const path = join(dir, "device-key");
  if (existsSync(path)) return new Uint8Array(readFileSync(path));
  const key = randomBytes(32);
  writePrivate(path, key);
  return key;
}

/** The pin of each server that makes its own certificate, by host and port. */
const pins = new Map<string, string>();

/**
 * Trusts a server that makes its own certificate by its key matching the pin its links
 * carry, and by nothing else, for everything this program sends it, as the apps do.
 */
export async function pinServer(url: string, pin: string): Promise<void> {
  const { hostname, port } = new URL(url);
  if (pins.size === 0) setGlobalDispatcher(pinnedAgent());
  pins.set(`${hostname}:${port || 443}`, pin);
}

/** Connections that trust a server with a pin by its key alone, and any other as usual. */
function pinnedAgent(): Agent {
  const usual = buildConnector({});
  // A resumed session shows no certificate to check, so each connection starts afresh.
  const own = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  return new Agent({
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
  });
}

/**
 * Connections of their own for what the bot adds to its chats without saying who it is,
 * so they share no connection and no TLS session with its signed-in requests.
 */
const sealedAgent = pinnedAgent();

/** A fetch on those connections, for `ZunaClientOptions.sealedFetch`. */
export const sealedFetch = (url: string, init: RequestInit): Promise<Response> => fetch(url, { ...init, dispatcher: sealedAgent } as RequestInit);
