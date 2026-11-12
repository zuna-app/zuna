// Writes each Lucide icon the desktop's interface imports (packages/ui) as an SVG in
// apps/desktop/assets/icons, from the same lucide-react the desktop draws them with,
// so the native app's icons are the same shapes. Run it after the interface starts
// using another icon:
//
//   node apps/desktop/scripts/icons.mjs [ExtraIconName ...]

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const lucide = join(root, "node_modules", "lucide-react", "dist", "esm");
const out = join(here, "..", "assets", "icons");

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|mts)$/.test(name) ? [path] : [];
  });
}

// Icons the shared interface doesn't import: the Plugins page's own, and some for plugins' views
// to name, which docs/PLUGINS.md lists beside the rest.
const PLUGIN_ICONS = ["Puzzle", "Store", "Blocks", "Sparkles", "Languages", "Package", "WandSparkles", "Type", "Rocket", "Star", "Heart", "Globe", "FolderOpen", "List", "FileCode", "Bug", "Keyboard", "Quote", "ScrollText", "Calculator", "Hourglass", "Music", "Gamepad2", "Sun", "Moon", "Cloud", "Tag", "Filter", "Sticker", "CircleHelp"];

// Every name imported from lucide-react anywhere in the shared interface.
const names = new Set([...PLUGIN_ICONS, ...process.argv.slice(2)]);
for (const file of sources(join(root, "packages", "ui", "src"))) {
  for (const match of readFileSync(file, "utf8").matchAll(/import\s*\{([^}]+)\}\s*from\s*"lucide-react"/g)) {
    for (const part of match[1].split(",")) {
      const name = part.replace(/\btype\b/, "").split(/\s+as\s+/)[0].trim();
      if (name && !name.endsWith("Props") && name !== "LucideIcon") names.add(name);
    }
  }
}

// lucide-react's index says which file each exported name comes from.
const index = readFileSync(join(lucide, "lucide-react.mjs"), "utf8");
const files = new Map();
for (const match of index.matchAll(/export \{([^}]*)\} from '\.\/icons\/([\w-]+)\.mjs'/g)) {
  for (const alias of match[1].matchAll(/default as (\w+)/g)) files.set(alias[1], match[2]);
}

const attributes = (props) =>
  Object.entries(props)
    .filter(([key]) => key !== "key")
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${String(value).replace(/"/g, "&quot;")}"`)
    .join(" ");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const missing = [];
for (const name of [...names].sort()) {
  const file = files.get(name) ?? files.get(`${name}Icon`) ?? files.get(name.replace(/Icon$/, ""));
  if (!file) {
    missing.push(name);
    continue;
  }
  const { __iconData } = await import(pathToFileURL(join(lucide, "icons", `${file}.mjs`)).href);
  const body = __iconData.node.map(([tag, props]) => `<${tag} ${attributes(props)}/>`).join("");
  // Black strokes: GPUI draws an SVG as a mask and fills it with the text color.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`;
  writeFileSync(join(out, `${file}.svg`), svg);
}
writeFileSync(join(out, "LICENSE.txt"), readFileSync(join(root, "node_modules", "lucide-react", "LICENSE")));
console.log(`> wrote ${names.size - missing.length} icons to ${out}`);
if (missing.length) console.log(`  not found in lucide-react: ${missing.join(", ")}`);
