// What a notification says about a message. The words are the same whether a
// connected session raises it (maybeNotify in session.ts) or a phone's
// notification extension works it out from a push (push.ts).

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

/** The title and text of a notification: the sender in a DM, the group with the sender's name otherwise. */
export function notificationText(
  kind: "dm" | "group",
  groupName: string | undefined,
  senderName: string,
  view: Preview,
): { title: string; body: string } {
  if (kind === "dm") return { title: senderName, body: previewText(view) };
  return { title: groupName || "Group", body: `${senderName}: ${previewText(view)}` };
}
