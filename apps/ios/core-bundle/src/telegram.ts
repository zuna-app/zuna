// A linked Telegram account's engine, which the host runs apart from the core behind its broker
// (docs/TELEGRAM_PLAN.md), for a host that has one: the native desktop app, and the iPhone, where
// the engine is a helper extension whose folder the app can't read, so a file is copied out first.

import type { TelegramAdapter } from "@zuna/core";
import { NativeFile } from "./files";

const g = globalThis as any;
let listener: ((json: string) => void) | null = null;
const copying = new Map<number, { resolve: (path: string) => void; reject: (error: Error) => void }>();
let nextCopy = 1;

g.__zunaTelegram = (json: string) => listener?.(json);
g.__zunaTelegramFile = (id: number, error: string | null, path: string | null) => {
  const waiting = copying.get(id);
  if (!waiting) return;
  copying.delete(id);
  if (path) waiting.resolve(path);
  else waiting.reject(new Error(error || "Telegram's file couldn't be read."));
};

export const nativeTelegram: TelegramAdapter | undefined =
  __zunaHost.telegramAvailable && __zunaHost.telegramStart && __zunaHost.telegramSend && __zunaHost.telegramStop
    ? {
        start(onMessage) {
          listener = onMessage;
          return __zunaHost.telegramStart!() || null;
        },
        send: (json) => __zunaHost.telegramSend!(json),
        stop: (signOut) => __zunaHost.telegramStop!(signOut),
        // The host checks it's inside the engine's folder before anything reads it.
        file(path, mime) {
          const copy = __zunaHost.telegramFile;
          if (!copy) return new NativeFile(path, mime) as unknown as Blob;
          const id = nextCopy++;
          return new Promise<Blob>((resolve, reject) => {
            copying.set(id, { resolve: (copied) => resolve(new NativeFile(copied, mime) as unknown as Blob), reject });
            copy(id, path);
          });
        },
      }
    : undefined;
