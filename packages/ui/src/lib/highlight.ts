// Code highlighting with Shiki. The engine and each language load on first use,
// so chats without code never pay for them.

import type { GrammarState, HighlighterCore, ThemedToken } from "shiki/core";

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
  })().catch((error: unknown) => {
    // Tried again for the next block, rather than never.
    highlighter = null;
    throw error;
  });
  return highlighter;
}

const results = new Map<string, ThemedToken[][]>();

// Anyone in a chat chooses what gets highlighted, on this thread, so only so much
// is, a few lines at a time: past these, the rest of a block shows uncolored.
const MAX_HIGHLIGHTED_CHARS = 20_000;
const MAX_HIGHLIGHTED_LINES = 500;
const MAX_TOKENIZED_LINE = 1_000;
const LINES_AT_A_TIME = 50;

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
  const lines = code.split("\n");
  let count = 0;
  let chars = 0;
  while (count < lines.length && count < MAX_HIGHLIGHTED_LINES && chars + lines[count]!.length <= MAX_HIGHLIGHTED_CHARS) chars += lines[count++]!.length + 1;
  const highlighted: ThemedToken[][] = [];
  let grammarState: GrammarState | undefined;
  for (let start = 0; start < count; start += LINES_AT_A_TIME) {
    // Between batches, the interface gets its turn, however much there is to color.
    if (start > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const batch = lines.slice(start, Math.min(start + LINES_AT_A_TIME, count)).join("\n");
    const result = instance.codeToTokens(batch, { lang: name, theme: "github-dark-default", tokenizeMaxLineLength: MAX_TOKENIZED_LINE, grammarState });
    highlighted.push(...result.tokens);
    grammarState = result.grammarState;
  }
  const rest = lines.slice(count).map((line): ThemedToken[] => [{ content: line, offset: 0 }]);
  const all = [...highlighted, ...rest];
  if (results.size > 500) results.clear();
  results.set(cacheKey, all);
  return all;
}
