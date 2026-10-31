// Code highlighting for the iOS app: the desktop's Shiki setup (same engine,
// theme, languages and aliases as apps/desktop/src/renderer/src/lib/highlight.ts),
// run in a JavaScriptCore context of its own so code blocks are colored exactly
// as on the desktop. Every language is bundled, since JavaScriptCore can't load
// modules on demand; the host loads this script only when a code block shows.

import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import theme from "shiki/themes/github-dark-default.mjs";
import bashLang from "shiki/langs/bash.mjs";
import cLang from "shiki/langs/c.mjs";
import cppLang from "shiki/langs/cpp.mjs";
import csharpLang from "shiki/langs/csharp.mjs";
import cssLang from "shiki/langs/css.mjs";
import diffLang from "shiki/langs/diff.mjs";
import dockerLang from "shiki/langs/docker.mjs";
import goLang from "shiki/langs/go.mjs";
import graphqlLang from "shiki/langs/graphql.mjs";
import htmlLang from "shiki/langs/html.mjs";
import javaLang from "shiki/langs/java.mjs";
import javascriptLang from "shiki/langs/javascript.mjs";
import jsonLang from "shiki/langs/json.mjs";
import jsxLang from "shiki/langs/jsx.mjs";
import kotlinLang from "shiki/langs/kotlin.mjs";
import luaLang from "shiki/langs/lua.mjs";
import markdownLang from "shiki/langs/markdown.mjs";
import phpLang from "shiki/langs/php.mjs";
import powershellLang from "shiki/langs/powershell.mjs";
import pythonLang from "shiki/langs/python.mjs";
import rubyLang from "shiki/langs/ruby.mjs";
import rustLang from "shiki/langs/rust.mjs";
import sqlLang from "shiki/langs/sql.mjs";
import swiftLang from "shiki/langs/swift.mjs";
import tomlLang from "shiki/langs/toml.mjs";
import tsxLang from "shiki/langs/tsx.mjs";
import typescriptLang from "shiki/langs/typescript.mjs";
import xmlLang from "shiki/langs/xml.mjs";
import yamlLang from "shiki/langs/yaml.mjs";

const languages: Record<string, LanguageRegistration[]> = {
  bash: bashLang,
  c: cLang,
  cpp: cppLang,
  csharp: csharpLang,
  css: cssLang,
  diff: diffLang,
  docker: dockerLang,
  go: goLang,
  graphql: graphqlLang,
  html: htmlLang,
  java: javaLang,
  javascript: javascriptLang,
  json: jsonLang,
  jsx: jsxLang,
  kotlin: kotlinLang,
  lua: luaLang,
  markdown: markdownLang,
  php: phpLang,
  powershell: powershellLang,
  python: pythonLang,
  ruby: rubyLang,
  rust: rustLang,
  sql: sqlLang,
  swift: swiftLang,
  toml: tomlLang,
  tsx: tsxLang,
  typescript: typescriptLang,
  xml: xmlLang,
  yaml: yamlLang,
};

const aliases: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  ps1: "powershell",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  cs: "csharp",
  "c#": "csharp",
  dockerfile: "docker",
  golang: "go",
  kt: "kotlin",
};

const languageName = (language: string): string | null => {
  const name = aliases[language.toLowerCase()] ?? language.toLowerCase();
  return languages[name] ? name : null;
};

const g = globalThis as any;

let highlighter: Promise<HighlighterCore> | null = null;

/** Calls `done` with JSON lines of [text, color] pairs, null for a language the desktop doesn't color, or an error message. */
g.__zunaHighlight = (code: string, language: string, done: (result: string | null, error: string | null) => void) => {
  const name = languageName(language);
  if (!name) {
    done(null, null);
    return;
  }
  highlighter ??= createHighlighterCore({
    themes: [theme],
    langs: [],
    // JavaScriptCore runs some grammar patterns differently with the newer regex
    // flags Shiki picks by default; ES2018 output matches the desktop token for token.
    engine: createJavaScriptRegexEngine({ target: "ES2018" }),
  });
  highlighter
    .then(async (instance) => {
      if (!instance.getLoadedLanguages().includes(name)) await instance.loadLanguage(languages[name]!);
      const { tokens } = instance.codeToTokens(code, { lang: name, theme: "github-dark-default" });
      done(JSON.stringify(tokens.map((line) => line.map((token) => [token.content, token.color ?? null]))), null);
    })
    .catch((error: Error) => done(null, String(error?.stack ?? error)));
};
