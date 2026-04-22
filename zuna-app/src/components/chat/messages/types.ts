import type { Message } from "@/types/serverTypes";

export type MessageStatus = "pending" | "sent" | "read";

export interface AttachmentMeta {
  name: string;
  size: number;
  mimeType: string;
}

export type GroupedMessage = Message & {
  isFirst: boolean;
  isLast: boolean;
  showDivider: boolean;
};

const _timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const _timeCache = new Map<number, string>();

export function formatTime(ms: number): string {
  // Key by minute – we only display HH:MM so two timestamps in the same
  // minute produce identical output and can share the cached string.
  const key = Math.floor(ms / 60_000);
  let cached = _timeCache.get(key);
  if (cached === undefined) {
    cached = _timeFormatter.format(new Date(key * 60_000));
    _timeCache.set(key, cached);
    // Keep memory bounded (1440 slots ≈ one day of unique minutes).
    if (_timeCache.size > 1440) _timeCache.clear();
  }
  return cached;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function messageKey(msg: Message): string {
  return msg.id != null ? String(msg.id) : `local-${msg.localId}`;
}

export function sameGroup(a: Message, b: Message): boolean {
  return a.senderId === b.senderId && b.sentAt - a.sentAt < 60 * 60 * 1000;
}

export function groupMessages(messages: Message[]): GroupedMessage[] {
  return messages.map((msg, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    return {
      ...msg,
      isFirst: !prev || !sameGroup(prev, msg),
      isLast: !next || !sameGroup(msg, next),
      showDivider:
        i > 0 && (!prev || msg.sentAt - prev.sentAt > 60 * 60 * 1000),
    };
  });
}

export function getStatus(msg: Message): MessageStatus {
  if (msg.pending) return "pending";
  if (msg.readAt) return "read";
  return "sent";
}
