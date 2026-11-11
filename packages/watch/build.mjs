// Builds watch.html, the page the native apps load into their system's web view: the player's
// controller (src/page.ts) inlined into a page with nothing else, under a content security
// policy that allows that script and YouTube's player alone. An app puts its player's origin in
// place of {{player}}, YouTube's or, in checks, the fake's.
//
//   import { buildWatchPage } from "packages/watch/build.mjs"; await buildWatchPage(outDir, target)

import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Writes watch.html into `outDir`, its script built for the engine `target` names. */
export async function buildWatchPage(outDir, target = "safari17") {
  const result = await build({
    entryPoints: [join(here, "src", "page.ts")],
    bundle: true,
    format: "iife",
    target,
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "warning",
  });
  const script = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src {{player}}">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>Video</title>
<style>html, body { margin: 0; height: 100%; background: #000; overflow: hidden; } #player { position: fixed; inset: 0; } .watch-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }</style>
</head>
<body>
<div id="player"></div>
<script>${script}</script>
</body>
</html>
`;
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, "watch.html");
  writeFileSync(file, page);
  return file;
}
