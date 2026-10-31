// Code highlighting for the iOS app: the desktop's Shiki setup (same engine,
// theme and languages), run in a JavaScriptCore context of its own so code
// blocks are colored exactly as on the desktop.

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import theme from "shiki/themes/github-dark-default.mjs";
import bash from "shiki/langs/bash.mjs";
import json from "shiki/langs/json.mjs";
import python from "shiki/langs/python.mjs";
import rust from "shiki/langs/rust.mjs";
import swift from "shiki/langs/swift.mjs";
import typescript from "shiki/langs/typescript.mjs";

const g = globalThis as any;

let highlighter: Promise<HighlighterCore> | null = null;

/** Calls `done` with JSON lines of [text, color] pairs, or an error message. */
g.__zunaHighlight = (code: string, language: string, done: (result: string | null, error: string | null) => void) => {
  highlighter ??= createHighlighterCore({
    themes: [theme],
    langs: [bash, json, python, rust, swift, typescript],
    // JavaScriptCore runs some grammar patterns differently with the newer regex
    // flags Shiki picks by default; ES2018 output matches the desktop token for token.
    engine: createJavaScriptRegexEngine({ target: "ES2018" }),
  });
  highlighter.then(
    (instance) => {
      const { tokens } = instance.codeToTokens(code, { lang: language, theme: "github-dark-default" });
      done(JSON.stringify(tokens.map((line) => line.map((token) => [token.content, token.color ?? null]))), null);
    },
    (error: Error) => done(null, String(error?.stack ?? error)),
  );
};
