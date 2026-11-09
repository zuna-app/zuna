// Text, both ways between Telegram's formatting and Zuna's markup, for what both have.
//
// Telegram gives a message's text plain, with entities that say which parts are bold, a
// link and so on, by their offsets in UTF-16 units, which is how JavaScript counts too.
// Zuna writes the formatting into the text itself: **bold**, _italic_, ~~struck~~,
// ||hidden||, `code`, a fenced block and "> " for a quote. It has no underline and no
// link under other words, so one loses its line and the other shows its address after.

export interface Entity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface Formatted {
  text: string;
  entities: Entity[];
}

// --- Zuna's markup, to Telegram's text and entities ---

// As the apps read them (packages/ui/src/lib/markup.tsx).
const INLINE: { type: string; pattern: RegExp }[] = [
  { type: "code", pattern: /`([^`\n]+)`/ },
  { type: "spoiler", pattern: /\|\|([^\n]+?)\|\|/ },
  { type: "bold", pattern: /\*\*([^\n]+?)\*\*/ },
  { type: "strikethrough", pattern: /~~([^\n]+?)~~/ },
  { type: "italic", pattern: /(?<![\w*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![\w*])/ },
  { type: "italic", pattern: /(?<![\w_])_([^\s_](?:[^\n_]*[^\s_])?)_(?![\w_])/ },
];
const MAX_DEPTH = 8;
const URL = /\bhttps?:\/\/(?:[^\s<>"'()]|\([^\s<>"'()]*\))*(?:[^\s<>"'.,;:!?()\]}]|\([^\s<>"'()]*\))/gi;
const MENTION = /(?<![\w@])@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})/g;
const COMMAND = /(?<![^\s])\/([A-Za-z0-9_]{1,32})(@[A-Za-z0-9_][A-Za-z0-9_.-]{1,31})?(?![^\s])/g;

function inline(source: string, out: Formatted, depth: number): void {
  let position = 0;
  while (position < source.length) {
    const rest = source.slice(position);
    let first: { type: string; match: RegExpExecArray } | null = null;
    for (const rule of depth < MAX_DEPTH ? INLINE : []) {
      const match = rule.pattern.exec(rest);
      if (match && (!first || match.index < first.match.index)) first = { type: rule.type, match };
    }
    if (!first) {
      out.text += rest;
      return;
    }
    out.text += rest.slice(0, first.match.index);
    const start = out.text.length;
    if (first.type === "code") out.text += first.match[1]!;
    else inline(first.match[1]!, out, depth + 1);
    out.entities.push({ type: first.type, offset: start, length: out.text.length - start });
    position += first.match.index + first.match[0].length;
  }
}

/** What Telegram finds in any text by itself: addresses, mentions and commands, outside code. */
function found(text: string, taken: Entity[]): Entity[] {
  const inCode = (offset: number) => taken.some((entity) => (entity.type === "code" || entity.type === "pre") && offset >= entity.offset && offset < entity.offset + entity.length);
  const entities: Entity[] = [];
  for (const [type, pattern] of [["url", URL], ["mention", MENTION], ["bot_command", COMMAND]] as const) {
    for (const match of text.matchAll(pattern)) {
      if (inCode(match.index)) continue;
      // An address holds what would read as a mention or a command inside it.
      if (type !== "url" && entities.some((entity) => entity.type === "url" && match.index >= entity.offset && match.index < entity.offset + entity.length)) continue;
      entities.push({ type, offset: match.index, length: match[0].length });
    }
  }
  return entities;
}

/** A message's text as Zuna's apps write it, as Telegram's plain text and entities. */
export function toTelegram(markup: string): Formatted {
  const out: Formatted = { text: "", entities: [] };
  const block = (start: string) => {
    if (out.text && !out.text.endsWith("\n")) out.text += "\n";
    out.text += start;
  };
  const prose = (chunk: string) => {
    if (!chunk.replace(/\n/g, "")) return;
    let quote: number | null = null;
    const endQuote = () => {
      if (quote !== null) out.entities.push({ type: "blockquote", offset: quote, length: out.text.length - quote });
      quote = null;
    };
    for (const line of chunk.replace(/^\n+|\n+$/g, "").split("\n")) {
      const quoted = /^>\s?/.test(line);
      if (!quoted) endQuote();
      block("");
      if (quoted && quote === null) quote = out.text.length;
      inline(quoted ? line.replace(/^>\s?/, "") : line, out, 0);
      // An empty line is still a line.
      if (line === "" || (quoted && line.replace(/^>\s?/, "") === "")) out.text += "\n";
    }
    endQuote();
  };
  let last = 0;
  for (const match of markup.matchAll(/```([^\s`]*)\n?([\s\S]*?)```/g)) {
    prose(markup.slice(last, match.index));
    block("");
    const code = match[2]!.replace(/\n$/, "");
    out.entities.push({ type: "pre", offset: out.text.length, length: code.length, ...(match[1] ? { language: match[1] } : {}) });
    out.text += code;
    last = match.index + match[0].length;
  }
  prose(markup.slice(last));
  out.text = out.text.replace(/\n+$/, "");
  out.entities = [...out.entities, ...found(out.text, out.entities)]
    .filter((entity) => entity.length > 0 && entity.offset + entity.length <= out.text.length)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  return out;
}

// --- Telegram's text and entities, to Zuna's markup ---

function wrap(entity: Entity, inner: string): string {
  switch (entity.type) {
    case "bold":
      return `**${inner}**`;
    case "italic":
      return `_${inner}_`;
    case "strikethrough":
      return `~~${inner}~~`;
    case "spoiler":
      return `||${inner}||`;
    case "code":
      return `\`${inner}\``;
    case "pre":
      return `\`\`\`${entity.language ?? ""}\n${inner}\n\`\`\``;
    case "text_link":
      return !entity.url || entity.url === inner ? inner : `${inner} (${entity.url})`;
    case "blockquote":
    case "expandable_blockquote":
      return inner.split("\n").map((line) => `> ${line}`).join("\n");
    default:
      // Underline, which Zuna hasn't got, and what its apps find in the text themselves.
      return inner;
  }
}

function render(text: string, entities: Entity[], start: number, end: number): string {
  let out = "";
  let position = start;
  for (let index = 0; index < entities.length; ) {
    const entity = entities[index]!;
    const close = entity.offset + entity.length;
    // One that runs past where it may is left as plain text.
    if (entity.offset < position || close > end || entity.length <= 0) {
      index++;
      continue;
    }
    out += text.slice(position, entity.offset);
    let next = index + 1;
    while (next < entities.length && entities[next]!.offset < close) next++;
    const literal = entity.type === "code" || entity.type === "pre";
    let piece = wrap(entity, literal ? text.slice(entity.offset, close) : render(text, entities.slice(index + 1, next), entity.offset, close));
    // A code block or a quote is on lines of its own in Zuna's markup, wherever Telegram had it.
    if (entity.type === "pre" || entity.type === "blockquote" || entity.type === "expandable_blockquote") {
      if (out !== "" && !out.endsWith("\n")) piece = `\n${piece}`;
      if (close < end && text[close] !== "\n") piece += "\n";
    }
    out += piece;
    position = close;
    index = next;
  }
  return out + text.slice(position, end);
}

/** Telegram's plain text and entities, as a message's text in Zuna's markup. */
export function fromTelegram({ text, entities }: Formatted): string {
  const ordered = entities
    .filter((entity) => Number.isSafeInteger(entity.offset) && Number.isSafeInteger(entity.length) && entity.offset >= 0)
    .sort((a, b) => a.offset - b.offset || b.length - a.length);
  return render(text, ordered, 0, text.length)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

// --- Telegram's parse modes, to its plain text and entities ---

export class ParseError extends Error {}

const HTML_TAGS: Record<string, string> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strikethrough",
  strike: "strikethrough",
  del: "strikethrough",
  "tg-spoiler": "spoiler",
  span: "spoiler",
  a: "text_link",
  code: "code",
  pre: "pre",
  blockquote: "blockquote",
};
const HTML_NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"' };

function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 0xfffd);
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10) || 0xfffd);
    return HTML_NAMED[name.toLowerCase()] ?? whole;
  });
}

function parseHtml(source: string): Formatted {
  const out: Formatted = { text: "", entities: [] };
  const open: { tag: string; entity: Entity }[] = [];
  let position = 0;
  for (const match of source.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g)) {
    out.text += decodeHtml(source.slice(position, match.index));
    position = match.index + match[0].length;
    const tag = match[2]!.toLowerCase();
    const type = HTML_TAGS[tag];
    if (!type) throw new ParseError(`Bad Request: can't parse entities: Unsupported start tag "${tag}"`);
    if (match[1]) {
      const last = open.pop();
      if (!last || last.tag !== tag) throw new ParseError(`Bad Request: can't parse entities: Unexpected end tag "${tag}"`);
      last.entity.length = out.text.length - last.entity.offset;
      if (last.entity.type) out.entities.push(last.entity);
      continue;
    }
    const attributes = match[3] ?? "";
    const entity: Entity = { type, offset: out.text.length, length: 0 };
    if (tag === "a") entity.url = decodeHtml(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes)?.slice(1).find((value) => value !== undefined) ?? "");
    const language = /class\s*=\s*["']language-([^"'\s]+)["']/i.exec(attributes)?.[1];
    const parent = open.at(-1);
    if (tag === "code" && parent?.tag === "pre") {
      // The code inside a block says which language the block is in, and is no entity of its own.
      if (language) parent.entity.language = language;
      entity.type = "";
    } else if (tag === "pre" && language) {
      entity.language = language;
    }
    open.push({ tag, entity });
  }
  if (open.length > 0) throw new ParseError(`Bad Request: can't parse entities: Can't find end tag corresponding to start tag "${open.at(-1)!.tag}"`);
  out.text += decodeHtml(source.slice(position));
  return out;
}

/** Where a character next stands that no backslash escapes, or -1. */
function unescaped(source: string, wanted: string, from: number): number {
  for (let index = from; index < source.length; index++) {
    if (source[index] === "\\") index++;
    else if (source.startsWith(wanted, index)) return index;
  }
  return -1;
}

function parseMarkdown(source: string, v2: boolean): Formatted {
  const out: Formatted = { text: "", entities: [] };
  const open: Entity[] = [];
  let quote: number | null = null;
  const toggle = (type: string) => {
    const at = open.findLastIndex((entity) => entity.type === type);
    if (at < 0) {
      open.push({ type, offset: out.text.length, length: 0 });
      return;
    }
    const [entity] = open.splice(at, 1);
    entity!.length = out.text.length - entity!.offset;
    out.entities.push(entity!);
  };
  for (let index = 0; index < source.length; ) {
    const char = source[index]!;
    const lineStart = index === 0 || source[index - 1] === "\n";
    if (v2 && lineStart) {
      if (char === ">") {
        if (quote === null) quote = out.text.length;
        index++;
        continue;
      }
      if (quote !== null) {
        // The line break that ended the quote isn't part of it.
        out.entities.push({ type: "blockquote", offset: quote, length: Math.max(0, out.text.length - 1 - quote) });
        quote = null;
      }
    }
    if (char === "\\" && index + 1 < source.length) {
      out.text += source[index + 1];
      index += 2;
    } else if (source.startsWith("```", index) && source.indexOf("```", index + 3) > 0) {
      const end = source.indexOf("```", index + 3);
      let code = source.slice(index + 3, end);
      const firstLine = code.indexOf("\n");
      let language = "";
      if (firstLine > 0 && /^[^\s`]+$/.test(code.slice(0, firstLine))) {
        language = code.slice(0, firstLine);
        code = code.slice(firstLine + 1);
      } else if (code.startsWith("\n")) {
        code = code.slice(1);
      }
      code = code.replace(/\n$/, "");
      out.entities.push({ type: "pre", offset: out.text.length, length: code.length, ...(language ? { language } : {}) });
      out.text += code;
      index = end + 3;
    } else if (char === "`" && source.indexOf("`", index + 1) > 0) {
      const end = source.indexOf("`", index + 1);
      out.entities.push({ type: "code", offset: out.text.length, length: end - index - 1 });
      out.text += source.slice(index + 1, end);
      index = end + 1;
    } else if (char === "[" && linkAt(source, index)) {
      const { close, end } = linkAt(source, index)!;
      const inner = parseMarkdown(source.slice(index + 1, close), v2);
      for (const entity of inner.entities) out.entities.push({ ...entity, offset: entity.offset + out.text.length });
      out.entities.push({ type: "text_link", offset: out.text.length, length: inner.text.length, url: source.slice(close + 2, end).replace(/\\(.)/g, "$1") });
      out.text += inner.text;
      index = end + 1;
    } else if (v2 && source.startsWith("||", index)) {
      toggle("spoiler");
      index += 2;
    } else if (v2 && source.startsWith("__", index)) {
      toggle("underline");
      index += 2;
    } else if (char === "*") {
      toggle("bold");
      index++;
    } else if (char === "_") {
      toggle("italic");
      index++;
    } else if (v2 && char === "~") {
      toggle("strikethrough");
      index++;
    } else {
      out.text += char;
      index++;
    }
  }
  if (quote !== null) out.entities.push({ type: "blockquote", offset: quote, length: out.text.length - quote });
  if (open.length > 0) throw new ParseError(`Bad Request: can't parse entities: Can't find end of ${open.at(-1)!.type} entity at byte offset ${open.at(-1)!.offset}`);
  return out;
}

function linkAt(source: string, index: number): { close: number; end: number } | null {
  const close = unescaped(source, "]", index + 1);
  if (close < 0 || source[close + 1] !== "(") return null;
  const end = unescaped(source, ")", close + 2);
  return end < 0 ? null : { close, end };
}

/** Text written in one of Telegram's parse modes, as its plain text and entities. */
export function parseMode(text: string, mode: string): Formatted {
  switch (mode.toLowerCase()) {
    case "html":
      return parseHtml(text);
    case "markdownv2":
      return parseMarkdown(text, true);
    case "markdown":
      return parseMarkdown(text, false);
    default:
      throw new ParseError(`Bad Request: unsupported parse_mode "${mode}"`);
  }
}

/** What a bot sent as a message's text, in whichever way it said how it's formatted, as Zuna's markup. */
export function markupOf(text: string, mode: unknown, entities: unknown): string {
  if (typeof mode === "string" && mode !== "") return fromTelegram(parseMode(text, mode));
  const given = Array.isArray(entities) ? (entities.filter((entity) => entity && typeof entity === "object" && typeof entity.type === "string") as Entity[]) : [];
  return fromTelegram({ text, entities: given });
}
