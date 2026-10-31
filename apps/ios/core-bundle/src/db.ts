// The core's LocalDb on top of the host's native SQLite. Like the desktop's
// adapter, every call is synchronous and nested transactions join the outer one.

import type { DbProvider, LocalDb, SqlValue } from "@zuna/core";

class NativeDb implements LocalDb {
  private depth = 0;

  constructor(private readonly handle: number) {}

  run(sql: string, params: SqlValue[] = []): void {
    __zunaDb.run(this.handle, sql, params);
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    return __zunaDb.all(this.handle, sql, params) as T[];
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    this.run("BEGIN");
    try {
      const result = fn();
      this.run("COMMIT");
      return result;
    } catch (error) {
      this.run("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void {
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
