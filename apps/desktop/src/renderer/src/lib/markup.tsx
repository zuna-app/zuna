// Turns message text into React elements. Nothing here creates raw HTML, so a
// message can't inject markup, however it's written.

import type { EmoteRef } from "@zuna/core";
import { Fragment, type ReactNode } from "react";
import { CodeBlock } from "@/components/CodeBlock";
import { Emote } from "@/components/Emote";
import { Spoiler } from "@/components/Spoiler";

export interface MarkupContext {
  serverUrl: string;
  emotes: Record<string, EmoteRef>;
  /** username (lowercase) -> user ID, for highlighting mentions. */
  mentionable: Map<string, string>;
  selfId: string;
  onMention?: (userId: string) => void;
}

type Inline = ReactNode;

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]/gi;

/** Messages that are only emoji or emotes render larger, up to a few of them. */
export function jumboSize(text: string, emotes: Record<string, EmoteRef>): 0 | 1 | 2 {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 6) return 0;
  const onlyEmotes = words.every((word) => emotes[word] || EMOJI_ONLY.test(word));
  if (!onlyEmotes) return 0;
  const glyphs = words.reduce(
    (sum, word) => sum + (emotes[word] ? 1 : [...new Intl.Segmenter().segment(word)].length),
    0,
  );
  if (glyphs > 8) return 0;
  return glyphs <= 3 ? 2 : 1;
}

function renderPlain(text: string, context: MarkupContext, keyPrefix: string): Inline[] {
  const nodes: Inline[] = [];
  const tokens = text.split(/(\s+)/);
  let buffer = "";
  const flush = (index: number) => {
    if (buffer) nodes.push(<Fragment key={`${keyPrefix}-t${index}`}>{buffer}</Fragment>);
    buffer = "";
  };
  tokens.forEach((token, index) => {
    const emote = context.emotes[token];
    if (emote) {
      flush(index);
      nodes.push(
        <Emote key={`${keyPrefix}-e${index}`} name={token} emote={emote} serverUrl={context.serverUrl} stackOnPrevious={emote.zeroWidth} />,
      );
      return;
    }
    const mention = token.match(/^@([A-Za-z0-9_][A-Za-z0-9_.-]{1,31})([.,:;!?]*)$/);
    const userId = mention ? context.mentionable.get(mention[1]!.toLowerCase()) : undefined;
    if (mention && userId) {
      flush(index);
      nodes.push(
        <button
          key={`${keyPrefix}-m${index}`}
          className={`mention${userId === context.selfId ? " is-self" : ""}`}
          onClick={() => context.onMention?.(userId)}
        >
          @{mention[1]}
        </button>,
      );
      if (mention[2]) buffer += mention[2];
      return;
    }
    buffer += token;
  });
  flush(tokens.length);
  return nodes;
}

function renderLinks(text: string, context: MarkupContext, keyPrefix: string): Inline[] {
  const nodes: Inline[] = [];
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index > last) nodes.push(...renderPlain(text.slice(last, match.index), context, `${keyPrefix}-${index}`));
    nodes.push(
      <a key={`${keyPrefix}-l${index}`} href={match[0]} target="_blank" rel="noreferrer noopener">
        {match[0]}
      </a>,
    );
    last = match.index + match[0].length;
    index++;
  }
  if (last < text.length) nodes.push(...renderPlain(text.slice(last), context, `${keyPrefix}-end`));
  return nodes;
}

const INLINE_RULES: { pattern: RegExp; render: (inner: string, key: string, context: MarkupContext) => Inline }[] = [
  { pattern: /`([^`\n]+)`/, render: (inner, key) => <code key={key} className="inline-code">{inner}</code> },
  { pattern: /\|\|([^\n]+?)\|\|/, render: (inner, key, context) => <Spoiler key={key}>{renderInline(inner, context, key)}</Spoiler> },
  { pattern: /\*\*([^\n]+?)\*\*/, render: (inner, key, context) => <strong key={key}>{renderInline(inner, context, key)}</strong> },
  { pattern: /~~([^\n]+?)~~/, render: (inner, key, context) => <del key={key}>{renderInline(inner, context, key)}</del> },
  { pattern: /(?<![\w*])\*([^\s*](?:[^\n*]*[^\s*])?)\*(?![\w*])/, render: (inner, key, context) => <em key={key}>{renderInline(inner, context, key)}</em> },
  { pattern: /(?<![\w_])_([^\s_](?:[^\n_]*[^\s_])?)_(?![\w_])/, render: (inner, key, context) => <em key={key}>{renderInline(inner, context, key)}</em> },
];

function renderInline(text: string, context: MarkupContext, keyPrefix: string): Inline[] {
  let earliest: { index: number; length: number; rule: (typeof INLINE_RULES)[number]; inner: string } | null = null;
  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(text);
    if (match && (!earliest || match.index < earliest.index)) {
      earliest = { index: match.index, length: match[0].length, rule, inner: match[1]! };
    }
  }
  if (!earliest) return renderLinks(text, context, keyPrefix);
  return [
    ...renderLinks(text.slice(0, earliest.index), context, `${keyPrefix}-a`),
    earliest.rule.render(earliest.inner, `${keyPrefix}-r`, context),
    ...renderInline(text.slice(earliest.index + earliest.length), context, `${keyPrefix}-b`),
  ];
}

interface Block {
  type: "text" | "code" | "quote";
  text: string;
  language?: string;
}

function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const fence = /```([^\s`]*)\n?([\s\S]*?)```/g;
  let last = 0;
  const pushText = (chunk: string) => {
    if (!chunk) return;
    const lines = chunk.replace(/^\n+|\n+$/g, "").split("\n");
    let current = null as Block | null;
    for (const line of lines) {
      const isQuote = /^>\s?/.test(line);
      const type = isQuote ? "quote" : "text";
      const value = isQuote ? line.replace(/^>\s?/, "") : line;
      if (current?.type === type) {
        current.text += `\n${value}`;
      } else {
        current = { type, text: value };
        blocks.push(current);
      }
    }
  };
  for (const match of text.matchAll(fence)) {
    pushText(text.slice(last, match.index));
    blocks.push({ type: "code", text: match[2]!.replace(/\n$/, ""), language: match[1] || undefined });
    last = match.index + match[0].length;
  }
  pushText(text.slice(last));
  return blocks;
}

/**
 * Renders a message. `trailing` (the time) goes at the end of the last line of
 * text, so it can share that line, or on a line of its own after a code block.
 */
export function renderMarkup(text: string, context: MarkupContext, trailing?: ReactNode): ReactNode {
  const blocks = splitBlocks(text);
  const last = blocks[blocks.length - 1];
  const nodes = blocks.map((block, index) => {
    if (block.type === "code") return <CodeBlock key={index} code={block.text} language={block.language} />;
    if (block.type === "quote") {
      return (
        <blockquote key={index} className="quote">
          {renderInline(block.text, context, `q${index}`)}
        </blockquote>
      );
    }
    return (
      <span key={index} className="text-block">
        {renderInline(block.text, context, `p${index}`)}
        {block === last && trailing}
      </span>
    );
  });
  if (trailing && last?.type !== "text") {
    nodes.push(
      <span key="trailing" className="text-block">
        {trailing}
      </span>,
    );
  }
  return nodes;
}
