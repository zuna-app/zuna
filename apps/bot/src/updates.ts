// The updates a bot's code hasn't taken yet, and the two ways it takes them: asking,
// with getUpdates, or being sent each one, at a webhook. They're kept on disk, in order,
// until they're taken, as Telegram's are, so the code can restart without missing any.

import { ApiFailure, type Params, integer, strings, text } from "./params";
import { directAgent } from "./host";
import type { BotStore } from "./store";

/** The kinds of update zuna-bot makes. */
export const UPDATE_KINDS = ["message", "edited_message", "callback_query", "my_chat_member"] as const;

const LONGEST_POLL_S = 50;
const MOST_AT_ONCE = 100;
const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 60_000;
const WEBHOOK_TIMEOUT_MS = 30_000;

type Update = Record<string, unknown>;

export class Updates {
  private waiting: { finish: (updates: Update[]) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private delivering = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = FIRST_RETRY_MS;
  private lastError: { at: number; message: string } | null = null;
  private stopped = false;

  /** `call` runs a method, for a webhook's answer that asks for one. */
  constructor(
    private readonly store: BotStore,
    private readonly call: (method: string, params: Params) => Promise<unknown>,
  ) {}

  start(): void {
    this.deliverSoon();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.finishWaiting([]);
  }

  private get webhook(): { url: string; secret: string } | null {
    const url = this.store.get("webhook_url");
    return url ? { url, secret: this.store.get("webhook_secret") ?? "" } : null;
  }

  private allowed(kind: string): boolean {
    const allowed = this.store.get("allowed_updates");
    return !allowed || (JSON.parse(allowed) as string[]).includes(kind);
  }

  /** Keeps an update for the bot's code, unless it said it doesn't want that kind. */
  push(kind: (typeof UPDATE_KINDS)[number], body: Record<string, unknown>): void {
    if (!this.allowed(kind)) return;
    this.store.pushUpdate({ [kind]: body });
    if (this.waiting) this.finishWaiting(this.store.updates(0, MOST_AT_ONCE));
    this.deliverSoon();
  }

  private finishWaiting(updates: Update[]): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    clearTimeout(waiting.timer);
    waiting.finish(updates);
  }

  private setAllowed(params: Params): void {
    const kinds = strings(params, "allowed_updates");
    if (kinds) this.store.set("allowed_updates", kinds.length > 0 ? JSON.stringify(kinds) : null);
  }

  // --- getUpdates ---

  async get(params: Params): Promise<Update[]> {
    if (this.webhook) throw new ApiFailure(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
    this.setAllowed(params);
    const offset = integer(params, "offset") ?? 0;
    const limit = Math.min(Math.max(integer(params, "limit") ?? MOST_AT_ONCE, 1), MOST_AT_ONCE);
    const timeout = Math.min(Math.max(integer(params, "timeout") ?? 0, 0), LONGEST_POLL_S);
    // Whoever was asking before is answered, as only one can be waiting.
    this.finishWaiting([]);
    let ready: Update[];
    if (offset < 0) {
      // The last few, and everything before them is let go of.
      ready = this.store.lastUpdates(Math.min(-offset, limit));
      const first = ready[0]?.update_id;
      if (typeof first === "number") this.store.confirm(first);
    } else {
      // Asking from a number on says everything before it was taken.
      if (offset > 0) this.store.confirm(offset);
      ready = this.store.updates(offset, limit);
    }
    if (ready.length > 0 || timeout === 0 || this.stopped) return ready;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishWaiting([]), timeout * 1000);
      this.waiting = { finish: (updates) => resolve(updates.slice(0, limit)), timer };
    });
  }

  // --- Webhooks ---

  setWebhook(params: Params): true {
    const url = text(params, "url") ?? "";
    if (url === "") return this.deleteWebhook(params);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiFailure(400, "Bad Request: bad webhook: Failed to parse the address");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new ApiFailure(400, "Bad Request: bad webhook: An HTTP or HTTPS address must be provided for webhook");
    const secret = text(params, "secret_token") ?? "";
    if (!/^[A-Za-z0-9_-]{0,256}$/.test(secret)) throw new ApiFailure(400, "Bad Request: secret token contains unallowed characters");
    if (params.drop_pending_updates === true || params.drop_pending_updates === "true") this.store.dropUpdates();
    this.setAllowed(params);
    this.store.set("webhook_url", parsed.href);
    this.store.set("webhook_secret", secret || null);
    this.lastError = null;
    this.finishWaiting([]);
    this.deliverSoon();
    return true;
  }

  deleteWebhook(params: Params): true {
    if (params.drop_pending_updates === true || params.drop_pending_updates === "true") this.store.dropUpdates();
    this.store.set("webhook_url", null);
    this.store.set("webhook_secret", null);
    clearTimeout(this.retry);
    return true;
  }

  info(): Record<string, unknown> {
    const allowed = this.store.get("allowed_updates");
    return {
      url: this.webhook?.url ?? "",
      has_custom_certificate: false,
      pending_update_count: this.store.pendingUpdates(),
      ...(this.lastError ? { last_error_date: Math.floor(this.lastError.at / 1000), last_error_message: this.lastError.message } : {}),
      ...(allowed ? { allowed_updates: JSON.parse(allowed) } : {}),
    };
  }

  private deliverSoon(): void {
    if (this.delivering || this.stopped || !this.webhook) return;
    this.delivering = true;
    void this.deliver();
  }

  /**
   * Sends the updates waiting to the webhook, one at a time and in order, each until it's taken.
   * It stops being busy as it finds nothing left, in the same turn, so an update kept just then
   * starts it again rather than waiting for the next.
   */
  private async deliver(): Promise<void> {
    try {
      for (;;) {
        const webhook = this.webhook;
        const [update] = this.store.updates(0, 1);
        if (!webhook || !update || this.stopped) return;
        try {
          // Directly, as it's the bot's own code, whatever proxy the bot reaches its server through.
          const response = await fetch(webhook.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(webhook.secret ? { "X-Telegram-Bot-Api-Secret-Token": webhook.secret } : {}) },
            body: JSON.stringify(update),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
            dispatcher: directAgent,
          } as RequestInit);
          if (!response.ok) throw new Error(`Wrong response from the webhook: ${response.status} ${response.statusText}`);
          this.store.confirm((update.update_id as number) + 1);
          this.retryDelay = FIRST_RETRY_MS;
          // The answer may ask for one method to be called, as Telegram's webhooks let it.
          const answer = (await response.json().catch(() => null)) as Params | null;
          if (answer && typeof answer.method === "string") await this.call(answer.method, answer).catch((error) => console.warn("[zuna-bot] what a webhook's answer asked for failed:", error instanceof Error ? error.message : error));
        } catch (error) {
          this.lastError = { at: Date.now(), message: error instanceof Error ? error.message : String(error) };
          clearTimeout(this.retry);
          this.retry = setTimeout(() => this.deliverSoon(), this.retryDelay);
          this.retryDelay = Math.min(this.retryDelay * 2, LONGEST_RETRY_MS);
          return;
        }
      }
    } finally {
      this.delivering = false;
    }
  }
}
