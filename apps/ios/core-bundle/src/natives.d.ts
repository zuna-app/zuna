// Functions the Swift host installs in the JavaScript context before the
// bundle runs. See apps/ios/ZunaKit/Sources/ZunaHost.

declare const __zunaHost: {
  /** True only in Debug builds of the host, which turn on the test hooks. */
  testHooks?: boolean;
  /** True where the app lists bots in a section of their own, which the native desktop app does. One that doesn't is given no chat with a bot nobody has written to yet. */
  listsBots?: boolean;
  log(level: string, message: string): void;
  setTimer(id: number, ms: number, repeats: boolean): void;
  clearTimer(id: number): void;
  utf8Encode(text: string): Uint8Array;
  utf8Decode(bytes: Uint8Array): string;
  base64Encode(bytes: Uint8Array): string;
  base64Decode(text: string): Uint8Array;
  /** A sign-in, password change or sign-out, as JSON, for the app's device lock. */
  accountEvent(json: string): void;
  /** Channel 0 broadcasts to every channel. */
  post(channel: number, json: string): void;
  /** `sealed` sends it on connections of their own, with a TLS session cache of their own, sharing nothing with the session's requests. */
  http(id: number, method: string, url: string, headers: string, body: Uint8Array | string | null, timeoutMs: number, sealed: boolean): void;
  httpCancel(id: number): void;
  wsOpen(id: number, url: string): void;
  wsSend(id: number, text: string): void;
  wsClose(id: number, code: number): void;
  /** Trusts a server's own certificate by its pin, and no other for that address. False if it can't have one. */
  pinServer(url: string, pin: string): boolean;
  fileSize(path: string): number;
  fileRead(path: string, start: number, end: number): Uint8Array;
  /** Writes the parts to a new file in the protected cache and returns its path. */
  fileAssemble(parts: Uint8Array[], extension: string): string;
  /** Fetches a page or picture for a link preview; the result comes back through __zunaWebDone. */
  webFetch(id: number, url: string, maxBytes: number): void;
  /** Shrinks a picture to fit within maxSize pixels, as a JPEG data URL. */
  imageShrink(bytes: Uint8Array, maxSize: number): { data: string; width: number; height: number } | null;
  /**
   * A linked Telegram account's engine, behind the host's broker (docs/TELEGRAM_PLAN.md), which
   * the native desktop app and the iPhone give. What it says comes back through __zunaTelegram.
   */
  telegramAvailable?: boolean;
  /** Starts the engine, and says why it can't, or "". */
  telegramStart?(): string;
  telegramSend?(json: string): void;
  telegramStop?(signOut: boolean): void;
  /**
   * A file the engine downloaded, copied where the interface can read it, for a host whose
   * engine keeps its folder where the app can't, as the iPhone's helper does. The copy's path,
   * or why there's none, comes back through __zunaTelegramFile with the same id.
   */
  telegramFile?(id: number, path: string): void;
};

declare const __zunaCrypto: {
  [name: string]: (...args: any[]) => any;
  mlsNew(devicePublic: Uint8Array, deviceSecret: Uint8Array, credential: Uint8Array, state: unknown[]): number;
  mlsFree(handle: number): void;
  mls(handle: number, method: string, ...args: unknown[]): any;
};

declare const __zunaDb: {
  open(name: string): number;
  /** Runs one or more statements without parameters, such as a migration. */
  run(handle: number, sql: string): void;
  /** Prepares one statement, kept until `drop` or its database closes, and gives its number. */
  prepare(handle: number, sql: string): number;
  query(statement: number, params: unknown[]): any[];
  exec(statement: number, params: unknown[]): void;
  /** Finalizes every statement prepared for a database. */
  drop(handle: number): void;
  close(handle: number): void;
  remove(name: string): void;
};

