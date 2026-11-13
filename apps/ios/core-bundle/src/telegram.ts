// A linked Telegram account's engine, which the host runs apart from the core behind its broker
// (docs/TELEGRAM_PLAN.md), for a host that has one. Only the native desktop app does so far.

import type { TelegramAdapter } from "@zuna/core";
import { NativeFile } from "./files";

const g = globalThis as any;
let listener: ((json: string) => void) | null = null;

g.__zunaTelegram = (json: string) => listener?.(json);

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
        file: (path, mime) => new NativeFile(path, mime) as unknown as Blob,
      }
    : undefined;
