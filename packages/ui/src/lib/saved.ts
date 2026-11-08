// Reading back settings this device saved, which may be from an older version, or edited.

/**
 * What's saved, kept to the keys the defaults have, each of its default's type, or for a
 * default of null a number too, and one of its choices where they're given. Anything else
 * takes its default, so a key an older version saved isn't saved again for ever, and a
 * value outside its choices never reaches the app.
 */
export function keepKnown<T extends object>(defaults: T, stored: unknown, choices: { [K in keyof T]?: readonly T[K][] } = {}): T {
  const result = { ...defaults };
  if (!stored || typeof stored !== "object") return result;
  for (const key of Object.keys(defaults) as (keyof T)[]) {
    const value = (stored as Partial<Record<keyof T, unknown>>)[key];
    const fallback = defaults[key];
    const allowed = choices[key] as readonly unknown[] | undefined;
    const fits = allowed ? allowed.includes(value) : fallback === null ? value === null || typeof value === "number" : typeof value === typeof fallback;
    if (fits) result[key] = value as T[keyof T];
  }
  return result;
}

/** What's saved under a key, as JSON, or nothing when it's missing or unreadable. */
export function readSaved(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
