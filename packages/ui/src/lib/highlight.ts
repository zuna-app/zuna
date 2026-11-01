// Code highlighting with Shiki. The engine and each language load on first use,
// so chats without code never pay for them.

import type { HighlighterCore, ThemedToken } from "shiki/core";

const languages: Record<string, () => Promise<any>> = {
  bash: () => import("shiki/langs/bash.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
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

export const languageName = (language: string): string | null => {
  const name = aliases[language.toLowerCase()] ?? language.toLowerCase();
  return languages[name] ? name : null;
};

let highlighter: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, theme] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-dark-default.mjs"),
    ]);
    return createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return highlighter;
}

const results = new Map<string, ThemedToken[][]>();

/** Returns colored lines, or null for an unknown language. */
export async function highlightCode(code: string, language: string): Promise<ThemedToken[][] | null> {
  const name = languageName(language);
  if (!name) return null;
  const cacheKey = `${name}\0${code}`;
  const cached = results.get(cacheKey);
  if (cached) return cached;
  const instance = await getHighlighter();
  if (!instance.getLoadedLanguages().includes(name)) {
    await instance.loadLanguage((await languages[name]!()).default);
  }
  const { tokens } = instance.codeToTokens(code, { lang: name, theme: "github-dark-default" });
  if (results.size > 500) results.clear();
  results.set(cacheKey, tokens);
  return tokens;
}
