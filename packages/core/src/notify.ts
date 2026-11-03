// What a notification says about a message, and when a device shows it. The
// words are the same whether a connected session raises it (maybeNotify in
// session.ts) or a phone's notification extension works it out from a push
// (push.ts).

import { plainText } from "./plain-text";
import type { MessageView } from "./types";

type Preview = Pick<MessageView, "text" | "attachments"> & { location?: MessageView["location"] };

/** A message as one short line: its text, or what it carries. */
export function previewText(view: Preview): string {
  if (view.text) {
    const plain = plainText(view.text);
    return plain.length > 140 ? `${plain.slice(0, 140)}…` : plain;
  }
  if (view.location) return "📍 Location";
  const first = view.attachments[0];
  if (!first) return "";
  if (first.mime.startsWith("image/")) return "📷 Photo";
  if (first.mime.startsWith("video/")) return "🎬 Video";
  if (first.voice) return "🎤 Voice message";
  if (first.mime.startsWith("audio/")) return "🎵 Audio";
  return `📎 ${first.name}`;
}

/** Telegram's timings, in ms. Tests shorten them. */
export const notifyTiming = {
  /** online_cloud_timeout_ms: being on another device this recently still holds notifications here back. */
  elsewhereRecently: 5 * 60_000,
  /** notify_cloud_delay_ms: how long they're held. */
  elsewhereDelay: 30_000,
  /** notify_default_delay_ms: how long one waits while both devices are in use. */
  bothDelay: 1_500,
};

/** Where the person is, as far as one device knows: the times are ms, 0 for never. */
export interface WhereTheyAre {
  /** They're using this device now. */
  here: boolean;
  /** When they last stopped using this device. */
  leftHereAt: number;
  /** They're using another of their devices now. */
  elsewhereNow: boolean;
  /** When they last used another device, of those not in use now. */
  usedElsewhereAt: number;
}

/**
 * How long a notification waits before it shows on a device, as in Telegram
 * (System::countTiming in Telegram Desktop): 30 s while the person is on
 * another device, or was in the last 5 minutes and more recently than on this
 * one, and 1.5 s while they use both. If they read the chat meanwhile, it
 * doesn't show. The server holds phones' pushes back the same way (pushWait in
 * server/internal/api/hub.go).
 */
export function notificationDelay(where: WhereTheyAre, now = Date.now()): number {
  const elsewhere = where.elsewhereNow ? now : where.usedElsewhereAt;
  if (!where.here && now - elsewhere < notifyTiming.elsewhereRecently && elsewhere > where.leftHereAt) return notifyTiming.elsewhereDelay;
  if (where.elsewhereNow) return notifyTiming.bothDelay;
  return 0;
}

/** The title and text of a notification: the sender in a DM, the group with the sender's name otherwise. */
export function notificationText(
  kind: "dm" | "group" | "channel",
  groupName: string | undefined,
  senderName: string,
  view: Preview,
): { title: string; body: string } {
  if (kind === "dm") return { title: senderName, body: previewText(view) };
  return { title: groupName || "Group", body: `${senderName}: ${previewText(view)}` };
}
