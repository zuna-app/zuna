// SQLite compiled to WebAssembly, stored in the origin-private file system.
// Sensitive columns are already encrypted by the core before reaching here.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { DbProvider, LocalDb, SqlValue } from "@zuna/core";

/** How many compiled statements are kept, as the native app's host keeps (host/db.rs). */
const KEPT_STATEMENTS = 256;

class SqliteDb implements LocalDb {
  private depth = 0;
  /**
   * Statements compiled once and used again, which SQLite as WebAssembly otherwise
   * compiles for every query: a lookup by key took 7.6 µs that way and 3.2 µs kept,
   * for each of the eighteen or so queries the core makes for each message.
   */
  private readonly statements = new Map<string, any>();

  constructor(private readonly db: any) {}

  private statement(sql: string): any {
    let statement = this.statements.get(sql);
    if (!statement) {
      if (this.statements.size >= KEPT_STATEMENTS) {
        const [oldest, unused] = this.statements.entries().next().value!;
        this.statements.delete(oldest);
        unused.finalize();
      }
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Runs a kept statement with its parameters, giving each row it returns. */
  private each(sql: string, params: SqlValue[], row?: (value: unknown) => void): void {
    const statement = this.statement(sql);
    try {
      if (params.length) statement.bind(params);
      while (statement.step()) row?.(statement.get({}));
    } finally {
      statement.reset(true);
    }
  }

  run(sql: string, params: SqlValue[] = []): void {
    // Without parameters it may be several statements, as a migration is.
    if (params.length) this.each(sql, params);
    else this.db.exec(sql);
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    const rows: T[] = [];
    this.each(sql, params, (row) => rows.push(row as T));
    return rows;
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
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
    for (const statement of this.statements.values()) statement.finalize();
    this.statements.clear();
    this.db.close();
  }
}

/**
 * Opens the pool of database files. Another tab of the web app may have just
 * stopped, and the browser can take a moment to let go of its files.
 */
async function installPool(sqlite3: any): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs({ name: "zuna", directory: ".zuna-db", initialCapacity: 12 });
    } catch (error) {
      if (attempt >= 30) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Loads SQLite's WebAssembly, which touches no files yet, so it can start before the core boots. */
export const loadSqlite = (): Promise<unknown> => sqlite3InitModule();

export async function openSqliteProvider(loaded: Promise<unknown> = loadSqlite()): Promise<DbProvider> {
  const sqlite3 = await loaded;
  const pool = await installPool(sqlite3);
  const open = new Map<string, SqliteDb>();
  const path = (name: string) => `/${name}.sqlite`;
  return {
    async open(name) {
      const existing = open.get(name);
      if (existing) return existing;
      // Each database needs two pool slots: the file and its rollback journal.
      await pool.reserveMinimumCapacity(pool.getFileCount() + 4);
      const db = new pool.OpfsSAHPoolDb(path(name));
      db.exec("PRAGMA journal_mode = TRUNCATE; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -16000;");
      const wrapped = new SqliteDb(db);
      open.set(name, wrapped);
      return wrapped;
    },
    async remove(name) {
      open.get(name)?.close();
      open.delete(name);
      pool.unlink(path(name));
      // Its journal too, which TRUNCATE keeps, or it would hold a slot in the pool for good.
      try {
        pool.unlink(`${path(name)}-journal`);
      } catch {
        // There was none.
      }
    },
  };
}
