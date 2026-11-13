// A linked Telegram account's engine, which the host runs apart from the core behind its broker
// (docs/TELEGRAM_PLAN.md), for a host that has one. Only the native desktop app does so far.

import type { TelegramAdapter } from "@zuna/core";

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
      }
    : undefined;
