// Text between Telegram's formatting and Zuna's markup, both ways.

import { describe, expect, it } from "vitest";
import { ParseError, fromTelegram, markupOf, parseMode, toTelegram } from "../src/format";

describe("Zuna's markup, as Telegram's text and entities", () => {
  it("takes the formatting out of the text and says where it was", () => {
    expect(toTelegram("**bold** and _slanted_, ~~gone~~ ||hidden|| `code`")).toEqual({
      text: "bold and slanted, gone hidden code",
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 9, length: 7 },
        { type: "strikethrough", offset: 18, length: 4 },
        { type: "spoiler", offset: 23, length: 6 },
        { type: "code", offset: 30, length: 4 },
      ],
    });
  });

  it("keeps formatting inside formatting, and leaves code as it's written", () => {
    expect(toTelegram("**bold with _slant_** and `**not bold**`")).toEqual({
      text: "bold with slant and **not bold**",
      entities: [
        { type: "bold", offset: 0, length: 15 },
        { type: "italic", offset: 10, length: 5 },
        { type: "code", offset: 20, length: 12 },
      ],
    });
  });

  it("finds commands, mentions and addresses, which a bot's library looks for", () => {
    const { text, entities } = toTelegram("/start@echo now, @alice see https://example.com/a_b_c");
    expect(text).toBe("/start@echo now, @alice see https://example.com/a_b_c");
    expect(entities).toEqual([
      { type: "bot_command", offset: 0, length: 11 },
      { type: "mention", offset: 17, length: 6 },
      { type: "url", offset: 28, length: 25 },
    ]);
    // Not in the middle of a word or an address, and not in code.
    expect(toTelegram("a/b and `/start` and mail@example.com").entities).toEqual([{ type: "code", offset: 8, length: 6 }]);
  });

  it("reads code blocks and quotes", () => {
    expect(toTelegram("Look:\n```ts\nconst a = 1;\n```\n> quoted\n> twice\nafter")).toEqual({
      text: "Look:\nconst a = 1;\nquoted\ntwice\nafter",
      entities: [
        { type: "pre", offset: 6, length: 12, language: "ts" },
        { type: "blockquote", offset: 19, length: 12 },
      ],
    });
  });
});

describe("Telegram's text and entities, as Zuna's markup", () => {
  it("writes the formatting into the text", () => {
    const text = "bold slanted gone hidden code";
    expect(
      fromTelegram({
        text,
        entities: [
          { type: "bold", offset: 0, length: 4 },
          { type: "italic", offset: 5, length: 7 },
          { type: "strikethrough", offset: 13, length: 4 },
          { type: "spoiler", offset: 18, length: 6 },
          { type: "code", offset: 25, length: 4 },
        ],
      }),
    ).toBe("**bold** _slanted_ ~~gone~~ ||hidden|| `code`");
  });

  it("nests what's nested, drops what Zuna hasn't got, and shows a link's address", () => {
    expect(
      fromTelegram({
        text: "bold slant under link",
        entities: [
          { type: "bold", offset: 0, length: 10 },
          { type: "italic", offset: 5, length: 5 },
          { type: "underline", offset: 11, length: 5 },
          { type: "text_link", offset: 17, length: 4, url: "https://example.com/" },
        ],
      }),
    ).toBe("**bold _slant_** under link (https://example.com/)");
  });

  it("writes code blocks and quotes on lines of their own", () => {
    expect(
      fromTelegram({
        text: "Look: const a = 1; quoted\ntwice",
        entities: [
          { type: "pre", offset: 6, length: 12, language: "ts" },
          { type: "blockquote", offset: 19, length: 12 },
        ],
      }),
    ).toBe("Look: \n```ts\nconst a = 1;\n```\n \n> quoted\n> twice");
  });

  it("goes there and back", () => {
    for (const markup of ["**bold** and _slanted_", "a ||secret|| `x`", "~~no~~ **yes _both_**", "> quoted\nplain"]) {
      expect(fromTelegram(toTelegram(markup))).toBe(markup);
    }
  });
});

describe("Telegram's parse modes", () => {
  it("reads HTML", () => {
    expect(parseMode('<b>bold</b> &lt;3 <i>it</i> <a href="https://example.com/?a=1&amp;b=2">link</a> <tg-spoiler>s</tg-spoiler>', "HTML")).toEqual({
      text: "bold <3 it link s",
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 8, length: 2 },
        { type: "text_link", offset: 11, length: 4, url: "https://example.com/?a=1&b=2" },
        { type: "spoiler", offset: 16, length: 1 },
      ],
    });
    expect(parseMode('<pre><code class="language-py">print(1)</code></pre>', "html")).toEqual({ text: "print(1)", entities: [{ type: "pre", offset: 0, length: 8, language: "py" }] });
    expect(() => parseMode("<b>unclosed", "HTML")).toThrow(ParseError);
    expect(() => parseMode("<script>x</script>", "HTML")).toThrow(/Unsupported start tag/);
  });

  it("reads MarkdownV2, with its escapes", () => {
    expect(parseMode("*bold* _it_ __under__ ~gone~ ||hid|| `c` [link](https://example.com) 1\\.5\\!", "MarkdownV2")).toEqual({
      text: "bold it under gone hid c link 1.5!",
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 5, length: 2 },
        { type: "underline", offset: 8, length: 5 },
        { type: "strikethrough", offset: 14, length: 4 },
        { type: "spoiler", offset: 19, length: 3 },
        { type: "code", offset: 23, length: 1 },
        { type: "text_link", offset: 25, length: 4, url: "https://example.com" },
      ],
    });
    expect(parseMode("```js\nlet a;\n```", "MarkdownV2")).toEqual({ text: "let a;", entities: [{ type: "pre", offset: 0, length: 6, language: "js" }] });
    expect(parseMode(">quoted\n>more\nplain", "MarkdownV2")).toEqual({ text: "quoted\nmore\nplain", entities: [{ type: "blockquote", offset: 0, length: 11 }] });
    expect(() => parseMode("*never closed", "MarkdownV2")).toThrow(ParseError);
  });

  it("reads the older Markdown, where a tilde is only a tilde", () => {
    expect(parseMode("*bold* ~not~ _it_", "Markdown")).toEqual({
      text: "bold ~not~ it",
      entities: [
        { type: "bold", offset: 0, length: 4 },
        { type: "italic", offset: 11, length: 2 },
      ],
    });
  });

  it("makes Zuna's markup of whichever way a bot said its text is formatted", () => {
    expect(markupOf("<b>Hi</b> there", "HTML", undefined)).toBe("**Hi** there");
    expect(markupOf("Hi there", undefined, [{ type: "bold", offset: 0, length: 2 }])).toBe("**Hi** there");
    expect(markupOf("Hi there", undefined, undefined)).toBe("Hi there");
    expect(() => markupOf("x", "Wiki", undefined)).toThrow(/unsupported parse_mode/);
  });
});
