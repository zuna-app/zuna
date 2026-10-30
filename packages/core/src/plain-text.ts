/**
 * A message as one line of plain text, for previews and notifications. Spoilers
 * stay hidden here, since a preview is often seen without the reader choosing to.
 */
export function plainText(text: string): string {
  return text
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
