import { app } from "electron";
import fs from "fs";
import path from "path";

const DEBOUNCE_MS = 500;

export interface CacheInstance<T extends Record<string, unknown>> {
  get<K extends keyof T>(key: K): T[K];
  getAll(): T;
  set<K extends keyof T>(key: K, value: T[K]): void;
  flush(): void;
}

const registry = new Map<string, CacheInstance<Record<string, unknown>>>();

export function createCache<T extends Record<string, unknown>>(
  name: string,
  defaults: T,
): CacheInstance<T> {
  const filePath = path.join(app.getPath("userData"), `${name}.json`);
  let data: T = { ...defaults };
  let saveTimer: NodeJS.Timeout | null = null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<T>;
    data = { ...defaults, ...parsed };
  } catch {}

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush() {
    try {
      const tmp = filePath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
      fs.renameSync(tmp, filePath);
    } catch {
      // Ignore write errors
    }
  }

  const instance: CacheInstance<T> = {
    get<K extends keyof T>(key: K): T[K] {
      return data[key];
    },
    getAll(): T {
      return { ...data };
    },
    set<K extends keyof T>(key: K, value: T[K]): void {
      data[key] = value;
      scheduleSave();
    },
    flush,
  };

  registry.set(name, instance as CacheInstance<Record<string, unknown>>);
  return instance;
}

export function getCacheByName(
  name: string,
): CacheInstance<Record<string, unknown>> | undefined {
  return registry.get(name);
}

// ---------------------------------------------------------------------------
// Named cache instancees for app-wide use
// ---------------------------------------------------------------------------

export const windowStateCache = createCache("window-state", {
  width: 1450 as number,
  height: 1000 as number,
});

export const userCache = createCache("user-cache", {
  users: {} as Record<string, { username: string; avatar: string }>,
});
