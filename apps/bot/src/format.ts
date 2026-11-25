// Text, both ways between Telegram's formatting and Zuna's markup, for what both have.
//
// Telegram gives a message's text plain, with entities that say which parts are bold, a
// link and so on, by their offsets in UTF-16 units, which is how JavaScript counts too.
// Zuna writes the formatting into the text itself: **bold**, *italic*, ~~struck~~,
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
const INLINE: { type: string; token: string; pattern: RegExp }[] = [
  { type: "code", token: "`", pattern: /`([^`\n]+)`/g },
  { type: "spoiler", token: "||", pattern: /\|\|([^\n]+?)\|\|/g },
  { type: "bold", token: "**", pattern: /\*\*([^\n]+?)\*\*/g },
  { type: "strikethrough", token: "~~", pattern: /~~([^\n]+?)~~/g },
  { type: "italic", token: "*", pattern: /(?<![\w*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![\w*])/g },
];
const ITALIC_AT_START = /^\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![\w*])/;
const HAS_INLINE = /[`|*~]/;
const FENCE_RE = /```([^\s`]*)\n?([\s\S]*?)```/g;
const QUOTE_RE = /^>\s?/;
const NON_NL_RE = /[^\n]/;
const MAX_DEPTH = 8;
const URL = /\bhttps?:\/\/(?:[^\s<>"'()]|\([^\s<>"'()]*\))*(?:[^\s<>"'.,;:!?()\]}]|\([^\s<>"'()]*\))/gi;
const MENTION = /(?<![\w@])@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})/g;
const COMMAND = /(?<![^\s])\/([A-Za-z0-9_]{1,32})(@[A-Za-z0-9_][A-Za-z0-9_.-]{1,31})?(?![^\s])/g;
const HTML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;
const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>/g;
const HTML_HREF_RE = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const HTML_LANG_RE = /class\s*=\s*["']language-([^"'\s]+)["']/i;
const LANG_LINE_RE = /^[^\s`]+$/;
const UNESCAPE_RE = /\\(.)/g;

interface CachedMatch {
  index: number;
  end: number;
  inner: string;
}

function inline(source: string, out: Formatted, depth: number): void {
  if (depth >= MAX_DEPTH || !HAS_INLINE.test(source)) {
    out.text += source;
    return;
  }
  const active: number[] = [];
  for (let r = 0; r < INLINE.length; r++) {
    if (source.includes(INLINE[r]!.token)) active.push(r);
  }
  if (active.length === 0) {
    out.text += source;
    return;
  }
  const cache: (CachedMatch | null | undefined)[] = new Array(INLINE.length);
  let position = 0;
  while (position < source.length) {
    let bestRule = -1;
    let best: CachedMatch | null = null;
    for (let i = 0; i < active.length; i++) {
      const r = active[i]!;
      const rule = INLINE[r]!;
      let match = cache[r];
      // For italic, a match starting right at `position` ignores what preceded `position` (matching slice(position) semantics).
      if (r === 4 && position > 0 && source.charCodeAt(position) === 42) {
        const atPos = ITALIC_AT_START.exec(source.slice(position));
        if (atPos) {
          const direct: CachedMatch = { index: position, end: position + atPos[0].length, inner: atPos[1]! };
          if (!best || direct.index < best.index) {
            best = direct;
            bestRule = r;
          }
          continue;
        }
      }
      if (match === undefined || (match !== null && match.index < position)) {
        rule.pattern.lastIndex = position;
        const exec = rule.pattern.exec(source);
        match = exec ? { index: exec.index, end: exec.index + exec[0].length, inner: exec[1]! } : null;
        cache[r] = match;
      }
      if (match !== null && (!best || match.index < best.index)) {
        best = match;
        bestRule = r;
      }
    }
    if (!best) {
      out.text += position === 0 ? source : source.slice(position);
      return;
    }
    if (best.index > position) out.text += source.slice(position, best.index);
    const start = out.text.length;
    const type = INLINE[bestRule]!.type;
    if (type === "code") out.text += best.inner;
    else inline(best.inner, out, depth + 1);
    out.entities.push({ type, offset: start, length: out.text.length - start });
    position = best.end;
  }
}

/** What Telegram finds in any text by itself: addresses, mentions and commands, outside code. */
function found(text: string, taken: Entity[]): Entity[] {
  const codeStarts: number[] = [];
  const codeEnds: number[] = [];
  for (let i = 0; i < taken.length; i++) {
    const entity = taken[i]!;
    if (entity.type === "code" || entity.type === "pre") {
      codeStarts.push(entity.offset);
      codeEnds.push(entity.offset + entity.length);
    }
  }
  const inCode = (offset: number): boolean => {
    for (let i = 0; i < codeStarts.length; i++) if (offset >= codeStarts[i]! && offset < codeEnds[i]!) return true;
    return false;
  };
  const entities: Entity[] = [];
  const urlStarts: number[] = [];
  const urlEnds: number[] = [];
  if (text.includes("://")) {
    for (const match of text.matchAll(URL)) {
      if (inCode(match.index)) continue;
      const len = match[0].length;
      entities.push({ type: "url", offset: match.index, length: len });
      urlStarts.push(match.index);
      urlEnds.push(match.index + len);
    }
  }
  const inUrl = (offset: number): boolean => {
    for (let i = 0; i < urlStarts.length; i++) if (offset >= urlStarts[i]! && offset < urlEnds[i]!) return true;
    return false;
  };
  if (text.includes("@")) {
    for (const match of text.matchAll(MENTION)) {
      if (inCode(match.index) || inUrl(match.index)) continue;
      entities.push({ type: "mention", offset: match.index, length: match[0].length });
    }
  }
  if (text.includes("/")) {
    for (const match of text.matchAll(COMMAND)) {
      if (inCode(match.index) || inUrl(match.index)) continue;
      entities.push({ type: "bot_command", offset: match.index, length: match[0].length });
    }
  }
  return entities;
}

/** A message's text as Zuna's apps write it, as Telegram's plain text and entities. */
/**
 * A string without the newlines at its end, and at its start too unless told to leave them.
 * A loop, as a pattern takes far longer over a long run of them.
 */
function trimNewlines(text: string, both = true): string {
  let start = 0;
  let end = text.length;
  while (both && start < end && text[start] === "\n") start++;
  while (end > start && text[end - 1] === "\n") end--;
  return text.slice(start, end);
}

export function toTelegram(markup: string): Formatted {
  const out: Formatted = { text: "", entities: [] };
  const block = (start: string) => {
    if (out.text && !out.text.endsWith("\n")) out.text += "\n";
    out.text += start;
  };
  const prose = (chunk: string) => {
    if (!NON_NL_RE.test(chunk)) return;
    let quote: number | null = null;
    const endQuote = () => {
      if (quote !== null) out.entities.push({ type: "blockquote", offset: quote, length: out.text.length - quote });
      quote = null;
    };
    const lines = trimNewlines(chunk).split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const quoted = line.charCodeAt(0) === 62; // '>'
      if (!quoted) endQuote();
      block("");
      if (quoted && quote === null) quote = out.text.length;
      const content = quoted ? line.replace(QUOTE_RE, "") : line;
      inline(content, out, 0);
      // An empty line is still a line.
      if (line === "" || (quoted && content === "")) out.text += "\n";
    }
    endQuote();
  };
  if (markup.includes("```")) {
    let last = 0;
    for (const match of markup.matchAll(FENCE_RE)) {
      prose(markup.slice(last, match.index));
      block("");
      const code = match[2]!.replace(/\n$/, "");
      out.entities.push({ type: "pre", offset: out.text.length, length: code.length, ...(match[1] ? { language: match[1] } : {}) });
      out.text += code;
      last = match.index + match[0].length;
    }
    prose(markup.slice(last));
  } else {
    prose(markup);
  }
  out.text = trimNewlines(out.text, false);
  const auto = found(out.text, out.entities);
  if (auto.length > 0) for (let i = 0; i < auto.length; i++) out.entities.push(auto[i]!);
  out.entities = out.entities
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
      return `*${inner}*`;
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
  return trimNewlines(render(text, ordered, 0, text.length).replace(/\n{3,}/g, "\n\n"));
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
  if (!text.includes("&")) return text;
  return text.replace(HTML_ENTITY_RE, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16) || 0xfffd);
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10) || 0xfffd);
    return HTML_NAMED[name.toLowerCase()] ?? whole;
  });
}

function parseHtml(source: string): Formatted {
  const out: Formatted = { text: "", entities: [] };
  const open: { tag: string; entity: Entity }[] = [];
  let position = 0;
  for (const match of source.matchAll(HTML_TAG_RE)) {
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
    if (tag === "a") entity.url = decodeHtml(HTML_HREF_RE.exec(attributes)?.slice(1).find((value) => value !== undefined) ?? "");
    const language = HTML_LANG_RE.exec(attributes)?.[1];
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
  const code = wanted.charCodeAt(0);
  for (let index = from; index < source.length; index++) {
    const ch = source.charCodeAt(index);
    if (ch === 92) index++;
    else if (ch === code) return index;
  }
  return -1;
}

function parseMarkdown(source: string, v2: boolean): Formatted {
  const out: Formatted = { text: "", entities: [] };
  const open: Entity[] = [];
  let quote: number | null = null;
  let plainStart = 0;
  let noFence = false;
  let noBacktick = false;
  const flushPlain = (to: number) => {
    if (to > plainStart) out.text += source.slice(plainStart, to);
  };
  const toggle = (type: string) => {
    let at = -1;
    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i]!.type === type) {
        at = i;
        break;
      }
    }
    if (at < 0) {
      open.push({ type, offset: out.text.length, length: 0 });
      return;
    }
    const [entity] = open.splice(at, 1);
    entity!.length = out.text.length - entity!.offset;
    out.entities.push(entity!);
  };
  for (let index = 0; index < source.length; ) {
    const code = source.charCodeAt(index);
    const lineStart = index === 0 || source.charCodeAt(index - 1) === 10;
    if (v2 && lineStart) {
      if (code === 62) {
        flushPlain(index);
        if (quote === null) quote = out.text.length;
        index++;
        plainStart = index;
        continue;
      }
      if (quote !== null) {
        flushPlain(index);
        plainStart = index;
        // The line break that ended the quote isn't part of it.
        out.entities.push({ type: "blockquote", offset: quote, length: Math.max(0, out.text.length - 1 - quote) });
        quote = null;
      }
    }
    if (code === 92 && index + 1 < source.length) {
      flushPlain(index);
      out.text += source[index + 1];
      index += 2;
      plainStart = index;
    } else if (code === 96) {
      let handled = false;
      if (!noFence && source.charCodeAt(index + 1) === 96 && source.charCodeAt(index + 2) === 96) {
        const end = source.indexOf("```", index + 3);
        if (end > 0) {
          flushPlain(index);
          let snippet = source.slice(index + 3, end);
          const firstLine = snippet.indexOf("\n");
          let language = "";
          if (firstLine > 0 && LANG_LINE_RE.test(snippet.slice(0, firstLine))) {
            language = snippet.slice(0, firstLine);
            snippet = snippet.slice(firstLine + 1);
          } else if (snippet.startsWith("\n")) {
            snippet = snippet.slice(1);
          }
          if (snippet.endsWith("\n")) snippet = snippet.slice(0, -1);
          out.entities.push({ type: "pre", offset: out.text.length, length: snippet.length, ...(language ? { language } : {}) });
          out.text += snippet;
          index = end + 3;
          plainStart = index;
          handled = true;
        } else {
          noFence = true;
        }
      }
      if (!handled && !noBacktick) {
        const end = source.indexOf("`", index + 1);
        if (end > 0) {
          flushPlain(index);
          out.entities.push({ type: "code", offset: out.text.length, length: end - index - 1 });
          out.text += source.slice(index + 1, end);
          index = end + 1;
          plainStart = index;
          handled = true;
        } else {
          noBacktick = true;
        }
      }
      if (!handled) index++;
    } else if (code === 91) {
      const link = linkAt(source, index);
      if (link) {
        flushPlain(index);
        const inner = parseMarkdown(source.slice(index + 1, link.close), v2);
        const base = out.text.length;
        for (let i = 0; i < inner.entities.length; i++) {
          const entity = inner.entities[i]!;
          out.entities.push({ ...entity, offset: entity.offset + base });
        }
        out.entities.push({ type: "text_link", offset: base, length: inner.text.length, url: source.slice(link.close + 2, link.end).replace(UNESCAPE_RE, "$1") });
        out.text += inner.text;
        index = link.end + 1;
        plainStart = index;
      } else {
        index++;
      }
    } else if (v2 && code === 124 && source.charCodeAt(index + 1) === 124) {
      flushPlain(index);
      toggle("spoiler");
      index += 2;
      plainStart = index;
    } else if (v2 && code === 95 && source.charCodeAt(index + 1) === 95) {
      flushPlain(index);
      toggle("underline");
      index += 2;
      plainStart = index;
    } else if (code === 42) {
      flushPlain(index);
      toggle("bold");
      index++;
      plainStart = index;
    } else if (code === 95) {
      flushPlain(index);
      toggle("italic");
      index++;
      plainStart = index;
    } else if (v2 && code === 126) {
      flushPlain(index);
      toggle("strikethrough");
      index++;
      plainStart = index;
    } else {
      index++;
    }
  }
  flushPlain(source.length);
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
