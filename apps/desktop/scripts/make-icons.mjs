// Renders the app icon from its SVG source. electron-builder derives the
// platform formats (.ico, .icns) from the resulting PNG.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
const svg = readFileSync(join(resources, "icon.svg"));
const render = (size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();
writeFileSync(join(resources, "icon.png"), render(1024));
console.log("Wrote resources/icon.png");

// The Linux packages install each of these in hicolor, where a menu looks for the icon.
// hicolor has no folder for 1024x1024, so given icon.png alone, a menu found nothing.
mkdirSync(join(resources, "icons"), { recursive: true });
for (const size of [16, 24, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(join(resources, "icons", `${size}x${size}.png`), render(size));
}
console.log("Wrote resources/icons");
