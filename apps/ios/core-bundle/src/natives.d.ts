// Functions the Swift host installs in the JavaScript context before the
// bundle runs. See apps/ios/ZunaKit/Sources/ZunaHost.

declare const __zunaHost: {
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
  http(id: number, method: string, url: string, headers: string, body: Uint8Array | string | null, timeoutMs: number): void;
  httpCancel(id: number): void;
  wsOpen(id: number, url: string): void;
  wsSend(id: number, text: string): void;
  wsClose(id: number, code: number): void;
  fileSize(path: string): number;
  fileRead(path: string, start: number, end: number): Uint8Array;
  /** Writes the parts to a new file in the protected cache and returns its path. */
  fileAssemble(parts: Uint8Array[], extension: string): string;
};

declare const __zunaCrypto: {
  [name: string]: (...args: any[]) => any;
  mlsNew(devicePublic: Uint8Array, deviceSecret: Uint8Array, credential: Uint8Array, state: unknown[]): number;
  mlsFree(handle: number): void;
  mls(handle: number, method: string, ...args: unknown[]): any;
};

declare const __zunaDb: {
  open(name: string): number;
  run(handle: number, sql: string, params: unknown[]): void;
  all(handle: number, sql: string, params: unknown[]): any[];
  close(handle: number): void;
  remove(name: string): void;
};

declare const __ZUNA_TEST__: boolean;
