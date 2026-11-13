// Telegram's formatted text and Zuna's markup (packages/ui/src/lib/markup.tsx, which every app
// draws alike), each into the other. Telegram marks spans of plain text with entities, counted in
// UTF-16 code units as JavaScript counts a string, and Zuna marks them inside the text: **bold**,
// *italic*, ~~strike~~, ||spoiler||, `code`, fenced code blocks and quoted lines. What Zuna has no
// mark for, such as underline, stays plain text, and a link under other words keeps its address
// beside them.

/** A span of Telegram's formatted text, as TDLib's `textEntity` has it. */
export interface TdEntity {
  offset: number;
  length: number;
  type: { "@type": string; language?: string; url?: string; user_id?: number };
}

export interface FormattedText {
  text: string;
  entities: TdEntity[];
}

const INLINE: Record<string, string> = {
  textEntityTypeBold: "**",
  textEntityTypeItalic: "*",
  textEntityTypeStrikethrough: "~~",
  textEntityTypeSpoiler: "||",
  textEntityTypeCode: "`",
};

interface Insertion {
  at: number;
  text: string;
  /** Closings go before openings at the same place, and the innermost closes first. */
  closing: boolean;
  /** For ordering at one place: an opening's span length, a line's marks first, and a closing's start. */
  rank: number;
}

/** Telegram's formatted text as Zuna's markup. */
export function toMarkup(formatted: FormattedText): string {
  const { text } = formatted;
  const insertions: Insertion[] = [];
  const add = (at: number, insert: string, closing: boolean, rank: number) => insertions.push({ at, text: insert, closing, rank });
  for (const entity of formatted.entities) {
    let start = Math.max(0, Math.min(text.length, entity.offset));
    let end = Math.max(start, Math.min(text.length, entity.offset + entity.length));
    const kind = entity.type["@type"];
    const mark = INLINE[kind];
    if (mark) {
      // A mark only holds against something that isn't space, and never across a line.
      while (start < end && /\s/.test(text[start]!)) start++;
      while (end > start && /\s/.test(text[end - 1]!)) end--;
      if (start === end || text.slice(start, end).includes("\n")) continue;
      if (mark === "`" && text.slice(start, end).includes("`")) continue;
      add(start, mark, false, end - start);
      add(end, mark, true, start);
    } else if (kind === "textEntityTypePre" || kind === "textEntityTypePreCode") {
      const language = (entity.type.language ?? "").replace(/[^\w+#.-]/g, "").slice(0, 32);
      const before = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
      const after = end < text.length && text[end] !== "\n" ? "\n" : "";
      add(start, `${before}\`\`\`${language}\n`, false, Infinity);
      add(end, `\n\`\`\`${after}`, true, start);
    } else if (kind === "textEntityTypeBlockQuote" || kind === "textEntityTypeExpandableBlockQuote") {
      const before = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
      add(start, `${before}> `, false, Infinity);
      for (let at = text.indexOf("\n", start); at !== -1 && at < end - 1; at = text.indexOf("\n", at + 1)) add(at + 1, "> ", false, Infinity);
    } else if (kind === "textEntityTypeTextUrl" && entity.type.url) {
      const url = entity.type.url;
      if (text.slice(start, end) !== url && /^https?:\/\//i.test(url)) add(end, ` (${url})`, true, start);
    }
  }
  insertions.sort((a, b) => a.at - b.at || Number(b.closing) - Number(a.closing) || b.rank - a.rank);
  let out = "";
  let last = 0;
  for (const insertion of insertions) {
    out += text.slice(last, insertion.at) + insertion.text;
    last = insertion.at;
  }
  return out + text.slice(last);
}

// Zuna's inline marks, as markup.tsx finds them, in its order.
const RULES: { pattern: RegExp; kind: string; plain?: boolean }[] = [
  { pattern: /`([^`\n]+)`/y, kind: "textEntityTypeCode", plain: true },
  { pattern: /\|\|([^\n]+?)\|\|/y, kind: "textEntityTypeSpoiler" },
  { pattern: /\*\*([^\n]+?)\*\*/y, kind: "textEntityTypeBold" },
  { pattern: /~~([^\n]+?)~~/y, kind: "textEntityTypeStrikethrough" },
  { pattern: /(?<![\w*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![\w*])/y, kind: "textEntityTypeItalic" },
  { pattern: /(?<![\w_])_([^\s_](?:[^\n_]*[^\s_])?)_(?![\w_])/y, kind: "textEntityTypeItalic" },
];

/** Zuna's markup as Telegram's formatted text, for sending. */
export function fromMarkup(markup: string): FormattedText {
  const out: FormattedText = { text: "", entities: [] };
  const lines = markup.split("\n");
  let index = 0;
  const newline = () => {
    if (out.text.length > 0) out.text += "\n";
  };
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = line.match(/^```([\w+#.-]*)\s*$/);
    if (fence) {
      const close = lines.findIndex((candidate, at) => at > index && /^```\s*$/.test(candidate));
      if (close !== -1) {
        newline();
        const code = lines.slice(index + 1, close).join("\n");
        const offset = out.text.length;
        out.text += code;
        if (code.length > 0) {
          out.entities.push({ offset, length: code.length, type: fence[1] ? { "@type": "textEntityTypePreCode", language: fence[1] } : { "@type": "textEntityTypePre" } });
        }
        index = close + 1;
        continue;
      }
    }
    if (/^> ?/.test(line)) {
      newline();
      const offset = out.text.length;
      let first = true;
      while (index < lines.length && /^> ?/.test(lines[index]!)) {
        if (!first) out.text += "\n";
        inline(lines[index]!.replace(/^> ?/, ""), out);
        first = false;
        index++;
      }
      if (out.text.length > offset) out.entities.push({ offset, length: out.text.length - offset, type: { "@type": "textEntityTypeBlockQuote" } });
      continue;
    }
    if (index > 0) out.text += "\n";
    inline(line, out);
    index++;
  }
  out.entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return out;
}

/**
 * A mark's inner text, read again for the marks inside it. Each rule takes the nearest closing, or
 * has none of its mark inside, so no mark holds itself, and one chain of marks is at most as deep
 * as there are rules that nest.
 */
function inline(source: string, out: FormattedText): void {
  let at = 0;
  let plainFrom = 0;
  while (at < source.length) {
    let matched: { rule: (typeof RULES)[number]; match: RegExpExecArray } | null = null;
    for (const rule of RULES) {
      rule.pattern.lastIndex = at;
      const match = rule.pattern.exec(source);
      if (match) {
        matched = { rule, match };
        break;
      }
    }
    if (!matched) {
      at++;
      continue;
    }
    out.text += source.slice(plainFrom, at);
    const offset = out.text.length;
    const inner = matched.match[1]!;
    if (matched.rule.plain) out.text += inner;
    else inline(inner, out);
    out.entities.push({ offset, length: out.text.length - offset, type: { "@type": matched.rule.kind } });
    at += matched.match[0].length;
    plainFrom = at;
  }
  out.text += source.slice(plainFrom);
}
