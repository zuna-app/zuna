// The core's end of a linked Telegram account's engine (docs/TELEGRAM_PLAN.md). The host passes
// an adapter, which reaches TDLib through the app's broker, and this pairs each request with its
// answer by `@extra`, as TDLib's JSON interface does, and hands everything else on as updates.

/** What a host gives the core for Telegram. A host without it, as the web app and zuna-bot, has none. */
export interface TelegramAdapter {
  /** Starts the engine, or says why it can't. Every update and answer comes to `onMessage`, as JSON. */
  start(onMessage: (json: string) => void): string | null;
  /** One TDLib request, as JSON. The broker answers one it won't pass on with an error. */
  send(json: string): void;
  /**
   * Stops the engine. With `signOut`, the session is ended at Telegram first, if it can be, and
   * everything of the account's on this device is erased: `zunaStopped` says how it went.
   */
  stop(signOut: boolean): void;
  /**
   * A file the engine wrote in its own folder, by the path TDLib gives, as the host's files are
   * handed to the interface. The host checks it's inside that folder before anything reads it.
   */
  file(path: string, mime: string): Blob;
}

/** A TDLib object: its kind in `@type`, and its fields. */
export type TdObject = { "@type": string; [field: string]: unknown };

/** An error TDLib, or the broker, answered a request with. */
export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "TelegramError";
  }
}

/** How long a request may wait for its answer before it's given up on. */
const ANSWER_WAIT_MS = 120_000;

export class Engine {
  private pending = new Map<string, { resolve: (value: TdObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private next = 1;

  constructor(
    private readonly adapter: TelegramAdapter,
    private readonly onUpdate: (update: TdObject) => void,
  ) {}

  /** Starts the engine, or says why it couldn't. */
  start(): string | null {
    return this.adapter.start((json) => this.heard(json));
  }

  stop(signOut: boolean): void {
    this.adapter.stop(signOut);
    this.failAll(new TelegramError("Telegram stopped.", 503));
  }

  /** Asks TDLib something, and gives its answer, or its error as a TelegramError. */
  request<T extends TdObject = TdObject>(query: TdObject): Promise<T> {
    const extra = `c${this.next++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(extra)) reject(new TelegramError("Telegram didn't answer in time.", 504));
      }, ANSWER_WAIT_MS);
      this.pending.set(extra, { resolve: resolve as (value: TdObject) => void, reject, timer });
      this.adapter.send(JSON.stringify({ ...query, "@extra": extra }));
    });
  }

  /** Every request still waiting fails, as when the engine went. */
  failAll(error: Error): void {
    for (const [extra, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      this.pending.delete(extra);
      waiting.reject(error);
    }
  }

  private heard(json: string): void {
    let message: TdObject;
    try {
      message = JSON.parse(json);
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || typeof message["@type"] !== "string") return;
    const extra = message["@extra"];
    if (typeof extra === "string") {
      const waiting = this.pending.get(extra);
      if (!waiting) return;
      this.pending.delete(extra);
      clearTimeout(waiting.timer);
      if (message["@type"] === "error") {
        const text = typeof message.message === "string" ? message.message : "Telegram refused that.";
        waiting.reject(new TelegramError(text, typeof message.code === "number" ? message.code : 400));
      } else {
        waiting.resolve(message);
      }
      return;
    }
    this.onUpdate(message);
  }
}
