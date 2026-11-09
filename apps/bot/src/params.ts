// What a method was called with. Telegram takes parameters in the address, as a form, as
// JSON or as multipart, so a number may arrive as text and an object as JSON in a string.

export type Params = Record<string, unknown>;

/** A refusal, in the shape Telegram's API answers with. */
export class ApiFailure extends Error {
  constructor(
    readonly code: number,
    description: string,
    readonly parameters?: Record<string, unknown>,
  ) {
    super(description);
  }
}

export function text(params: Params, name: string): string | undefined {
  const value = params[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function integer(params: Params, name: string): number | undefined {
  const value = params[name];
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : undefined;
}

export function flag(params: Params, name: string): boolean {
  return params[name] === true || params[name] === "true" || params[name] === "1";
}

/** An object or a list, which a form carries as JSON in text. */
export function structured(params: Params, name: string): unknown {
  const value = params[name];
  if (typeof value !== "string") return value ?? undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new ApiFailure(400, `Bad Request: can't parse ${name} JSON object`);
  }
}

export function strings(params: Params, name: string): string[] | undefined {
  const value = structured(params, name);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

export function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === "") throw new ApiFailure(400, `Bad Request: ${name} is required`);
  return value;
}
