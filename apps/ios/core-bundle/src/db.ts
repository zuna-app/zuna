// The core's LocalDb on top of the host's native SQLite. Like the web's
// adapter, every call is synchronous and nested transactions join the outer one.
// Each statement is prepared once and then called by its number, so its SQL
// crosses over to the host only the first time.

import type { DbProvider, LocalDb, SqlValue } from "@zuna/core";

/** How many prepared statements a database keeps, as the web's adapter does. */
const KEPT_STATEMENTS = 256;

class NativeDb implements LocalDb {
  private depth = 0;
  private readonly statements = new Map<string, number>();

  constructor(private readonly handle: number) {}

  private statement(sql: string): number {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      if (this.statements.size >= KEPT_STATEMENTS) {
        __zunaDb.drop(this.handle);
        this.statements.clear();
      }
      statement = __zunaDb.prepare(this.handle, sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, params: SqlValue[] = []): void {
    // Without parameters it may be several statements at once, as a migration is.
    if (params.length === 0) __zunaDb.run(this.handle, sql);
    else __zunaDb.exec(this.statement(sql), params);
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return __zunaDb.query(this.statement(sql), params) as T[];
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    __zunaDb.exec(this.statement("BEGIN"), []);
    try {
      const result = fn();
      __zunaDb.exec(this.statement("COMMIT"), []);
      return result;
    } catch (error) {
      __zunaDb.exec(this.statement("ROLLBACK"), []);
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.statements.clear();
    __zunaDb.close(this.handle);
  }
}

const open = new Map<string, NativeDb>();

export const nativeDbProvider: DbProvider = {
  async open(name) {
    let db = open.get(name);
    if (!db) {
      db = new NativeDb(__zunaDb.open(name));
      open.set(name, db);
    }
    return db;
  },
  async remove(name) {
    open.delete(name);
    __zunaDb.remove(name);
  },
};
