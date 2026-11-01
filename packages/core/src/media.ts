// What a message holds, for the lists in a chat's details: its photos, videos,
// files, sound files, voice messages and links. Attachments are sorted the way the
// message itself shows them (packages/ui/src/features/chat/MessageItem.tsx).

import { sharedLinks } from "./links";
import type { Attachment, MediaKind, MessageBody } from "./types";

export const MEDIA_KINDS: readonly MediaKind[] = ["photo", "video", "file", "audio", "voice", "link"];

/** Which list an attachment goes in. A picture with no size can't be laid out, so it's a file. */
export function attachmentKind(attachment: Attachment): Exclude<MediaKind, "link"> {
  if (attachment.mime.startsWith("image/") && attachment.width) return "photo";
  if (attachment.voice) return "voice";
  if (attachment.mime.startsWith("video/")) return "video";
  if (attachment.mime.startsWith("audio/")) return "audio";
  return "file";
}

/** How many of each kind a message holds, leaving out those it has none of. */
export function mediaIn(body: Pick<MessageBody, "text" | "attachments">): Map<MediaKind, number> {
  const found = new Map<MediaKind, number>();
  for (const attachment of body.attachments ?? []) {
    const kind = attachmentKind(attachment);
    found.set(kind, (found.get(kind) ?? 0) + 1);
  }
  if (sharedLinks(body.text ?? "").length > 0) found.set("link", 1);
  return found;
}
