// The web APIs the client core expects, which a bare JavaScriptCore context
// doesn't have. Each one is as small as the core's use of it allows, and backed
// by the native host where that's faster or needs the OS.

import "core-js/actual/url";
import "core-js/actual/url-search-params";

const g = globalThis as any;

// --- Test builds: a movable clock ---

if (__ZUNA_TEST__) {
  // Lets tests move time forward, for weekly key rotation and similar rules.
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  g.__zunaTest = {
    setClockOffset(ms: number) {
      offset = ms;
    },
  };
}

// --- console ---

function describe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}${value.stack ? `\n${value.stack}` : ""}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const logAt = (level: string) => (...args: unknown[]) => __zunaHost.log(level, args.map(describe).join(" "));
g.console = { log: logAt("info"), info: logAt("info"), warn: logAt("warn"), error: logAt("error"), debug: logAt("debug") };

// --- Timers ---

interface Timer {
  fn: (...args: unknown[]) => void;
  args: unknown[];
  repeats: boolean;
}

const timers = new Map<number, Timer>();
let nextTimer = 1;

function addTimer(fn: Timer["fn"], ms: unknown, args: unknown[], repeats: boolean): number {
  const id = nextTimer++;
  timers.set(id, { fn, args, repeats });
  __zunaHost.setTimer(id, Math.max(0, Number(ms) || 0), repeats);
  return id;
}

function clearTimer(id: unknown): void {
  if (typeof id === "number" && timers.delete(id)) __zunaHost.clearTimer(id);
}

g.setTimeout = (fn: Timer["fn"], ms?: number, ...args: unknown[]) => addTimer(fn, ms, args, false);
g.setInterval = (fn: Timer["fn"], ms?: number, ...args: unknown[]) => addTimer(fn, ms, args, true);
g.clearTimeout = clearTimer;
g.clearInterval = clearTimer;
g.__zunaTimerFired = (id: number) => {
  const timer = timers.get(id);
  if (!timer) return;
  if (!timer.repeats) timers.delete(id);
  try {
    timer.fn(...timer.args);
  } catch (error) {
    console.error("Uncaught in a timer:", error);
  }
};
g.queueMicrotask ??= (fn: () => void) => void Promise.resolve().then(fn);

// --- Text and base64 ---

class TextEncoderPolyfill {
  readonly encoding = "utf-8";
  encode(text = ""): Uint8Array {
    return __zunaHost.utf8Encode(String(text));
  }
}

class TextDecoderPolyfill {
  readonly encoding = "utf-8";
  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (!input) return "";
    let bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
    // Like the standard decoder, drop a leading byte order mark.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    return __zunaHost.utf8Decode(bytes);
  }
}

g.TextEncoder = TextEncoderPolyfill;
g.TextDecoder = TextDecoderPolyfill;

g.btoa = (binary: string) => {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    const code = binary.charCodeAt(i);
    if (code > 255) throw new Error("The string to be encoded contains characters outside of the Latin1 range.");
    bytes[i] = code;
  }
  return __zunaHost.base64Encode(bytes);
};

g.atob = (text: string) => {
  const bytes = __zunaHost.base64Decode(String(text).replace(/[\t\n\f\r ]/g, ""));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return binary;
};

// --- Events and abort signals ---

class EventTargetLite {
  private listeners = new Map<string, Set<(event: any) => void>>();
  addEventListener(type: string, listener: (event: any) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: { type: string }): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

class AbortSignalPolyfill extends EventTargetLite {
  aborted = false;
  reason: unknown = undefined;
  onabort: ((event: unknown) => void) | null = null;

  static timeout(ms: number): AbortSignalPolyfill {
    const signal = new AbortSignalPolyfill();
    setTimeout(() => signal.abortWith(domError("TimeoutError", "The operation timed out.")), ms);
    return signal;
  }

  static abort(reason?: unknown): AbortSignalPolyfill {
    const signal = new AbortSignalPolyfill();
    signal.abortWith(reason ?? domError("AbortError", "This operation was aborted."));
    return signal;
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.reason;
  }

  abortWith(reason: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    const event = { type: "abort" };
    this.onabort?.(event);
    this.dispatchEvent(event);
  }
}

class AbortControllerPolyfill {
  readonly signal = new AbortSignalPolyfill();
  abort(reason?: unknown): void {
    this.signal.abortWith(reason ?? domError("AbortError", "This operation was aborted."));
  }
}

g.AbortSignal = AbortSignalPolyfill;
g.AbortController = AbortControllerPolyfill;

// --- Blob (in memory) ---

export class BlobPolyfill {
  readonly type: string;
  private readonly data: Uint8Array;

  constructor(parts: unknown[] = [], options: { type?: string } = {}) {
    const chunks = parts.map((part) => {
      if (part instanceof BlobPolyfill) return part.data;
      if (part instanceof Uint8Array) return part;
      if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
      if (part instanceof ArrayBuffer) return new Uint8Array(part);
      return __zunaHost.utf8Encode(String(part));
    });
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    this.data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      this.data.set(chunk, offset);
      offset += chunk.length;
    }
    this.type = options.type ?? "";
  }

  get size(): number {
    return this.data.length;
  }

  slice(start = 0, end = this.data.length, type = ""): BlobPolyfill {
    return new BlobPolyfill([this.data.subarray(start, end)], { type });
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.slice().buffer;
  }

  async bytes(): Promise<Uint8Array> {
    return this.data.slice();
  }

  async text(): Promise<string> {
    return __zunaHost.utf8Decode(this.data);
  }

  /** The bytes without copying, for the host. */
  get raw(): Uint8Array {
    return this.data;
  }
}

g.Blob = BlobPolyfill;

// --- fetch ---

class HeadersPolyfill {
  private readonly map = new Map<string, string>();
  constructor(init?: Record<string, string> | HeadersPolyfill) {
    if (init instanceof HeadersPolyfill) init.forEach((value, name) => this.set(name, value));
    else if (init) for (const [name, value] of Object.entries(init)) this.set(name, value);
  }
  get(name: string): string | null {
    return this.map.get(name.toLowerCase()) ?? null;
  }
  set(name: string, value: string): void {
    this.map.set(name.toLowerCase(), String(value));
  }
  has(name: string): boolean {
    return this.map.has(name.toLowerCase());
  }
  forEach(callback: (value: string, name: string) => void): void {
    this.map.forEach((value, name) => callback(value, name));
  }
  toObject(): Record<string, string> {
    return Object.fromEntries(this.map);
  }
}

class ResponsePolyfill {
  readonly ok: boolean;
  readonly headers: HeadersPolyfill;
  constructor(
    private readonly body: Uint8Array,
    readonly status: number,
    headers: Record<string, string>,
  ) {
    this.ok = status >= 200 && status < 300;
    this.headers = new HeadersPolyfill(headers);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.body.slice().buffer;
  }
  async bytes(): Promise<Uint8Array> {
    return this.body;
  }
  async text(): Promise<string> {
    return __zunaHost.utf8Decode(this.body);
  }
  async json(): Promise<unknown> {
    return JSON.parse(__zunaHost.utf8Decode(this.body));
  }
}

const requests = new Map<number, { resolve: (response: ResponsePolyfill) => void; reject: (error: unknown) => void }>();
let nextRequest = 1;

g.Headers = HeadersPolyfill;
g.Response = ResponsePolyfill;
g.fetch = (input: unknown, init: { method?: string; headers?: any; body?: unknown; signal?: AbortSignalPolyfill } = {}) =>
  new Promise<ResponsePolyfill>((resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const id = nextRequest++;
    const headers = new HeadersPolyfill(init.headers).toObject();
    let body: Uint8Array | string | null = null;
    if (init.body instanceof BlobPolyfill) body = init.body.raw;
    else if (init.body instanceof Uint8Array) body = init.body;
    else if (ArrayBuffer.isView(init.body)) body = new Uint8Array(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    else if (init.body instanceof ArrayBuffer) body = new Uint8Array(init.body);
    else if (init.body != null) body = String(init.body);
    requests.set(id, { resolve, reject });
    signal?.addEventListener("abort", () => {
      if (!requests.delete(id)) return;
      __zunaHost.httpCancel(id);
      reject(signal.reason);
    });
    __zunaHost.http(id, (init.method ?? "GET").toUpperCase(), String(input), JSON.stringify(headers), body, 0);
  });

g.__zunaHttpDone = (id: number, status: number, headers: string, body: Uint8Array | null, error: string | null) => {
  const request = requests.get(id);
  if (!request) return;
  requests.delete(id);
  if (error !== null) request.reject(new TypeError(`Load failed: ${error}`));
  else request.resolve(new ResponsePolyfill(body ?? new Uint8Array(0), status, JSON.parse(headers)));
};

// --- WebSocket ---

const sockets = new Map<number, WebSocketPolyfill>();
let nextSocket = 1;

class WebSocketPolyfill {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  private readonly id = nextSocket++;

  constructor(readonly url: string) {
    sockets.set(this.id, this);
    __zunaHost.wsOpen(this.id, url);
  }

  send(text: string): void {
    if (this.readyState !== 1) throw domError("InvalidStateError", "The WebSocket is not open.");
    __zunaHost.wsSend(this.id, String(text));
  }

  close(code = 1000): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    __zunaHost.wsClose(this.id, code);
  }

  /** Called by the host. */
  receive(type: string, data: string | null, code: number): void {
    switch (type) {
      case "open":
        this.readyState = 1;
        this.onopen?.({ type });
        break;
      case "message":
        this.onmessage?.({ data: data ?? "" });
        break;
      case "error":
        this.onerror?.({ type });
        break;
      case "close":
        this.readyState = 3;
        sockets.delete(this.id);
        this.onclose?.({ code, reason: "", wasClean: code === 1000 });
        break;
    }
  }
}

g.WebSocket = WebSocketPolyfill;
g.__zunaWsEvent = (id: number, type: string, data: string | null, code: number) => sockets.get(id)?.receive(type, data, code);
