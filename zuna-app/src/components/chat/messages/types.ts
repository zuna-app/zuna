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

export function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));
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
  return a.senderId === b.senderId && b.sentAt - a.sentAt < 5 * 60 * 1000;
}

export function groupMessages(messages: Message[]): GroupedMessage[] {
  return messages.map((msg, i) => {
    const prev = messages[i - 1];
    const next = messages[i + 1];
    return {
      ...msg,
      isFirst: !prev || !sameGroup(prev, msg),
      isLast: !next || !sameGroup(msg, next),
      showDivider: i > 0 && (!prev || msg.sentAt - prev.sentAt > 5 * 60 * 1000),
    };
  });
}

export function getStatus(msg: Message): MessageStatus {
  if (msg.pending) return "pending";
  if (msg.readAt) return "read";
  return "sent";
}
