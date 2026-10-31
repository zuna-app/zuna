const MAX_INPUT = 4096;

/**
 * A message as one line of plain text, for previews and notifications. Spoilers
 * stay hidden here, since a preview is often seen without the reader choosing to.
 */
export function plainText(text: string): string {
  // Only ever shown as one short line, however long the message is.
  return text
    .slice(0, MAX_INPUT)
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/\|\|[^\n]+?\|\|/g, "[spoiler]")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\*\*([^\n]+?)\*\*/g, "$1")
    .replace(/~~([^\n]+?)~~/g, "$1")
    .replace(/(?<![\w*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![\w*])/g, "$1")
    .replace(/(?<![\w_])_([^\s_](?:[^\n_]*[^\s_])?)_(?![\w_])/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
