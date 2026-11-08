// SQLite compiled to WebAssembly, stored in the origin-private file system.
// Sensitive columns are already encrypted by the core before reaching here.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { DbProvider, LocalDb, SqlValue } from "@zuna/core";

class SqliteDb implements LocalDb {
  private depth = 0;

  constructor(private readonly db: any) {}

  run(sql: string, params: SqlValue[] = []): void {
    this.db.exec({ sql, bind: params.length ? params : undefined });
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return this.db.exec({
      sql,
      bind: params.length ? params : undefined,
      rowMode: "object",
      returnValue: "resultRows",
    }) as T[];
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

export async function openSqliteProvider(): Promise<DbProvider> {
  const sqlite3 = await sqlite3InitModule();
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
