// Renders the app icon from its SVG source. electron-builder derives the
// platform formats (.ico, .icns) from the resulting PNG.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
const svg = readFileSync(join(resources, "icon.svg"));
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
writeFileSync(join(resources, "icon.png"), png);
console.log("Wrote resources/icon.png");
