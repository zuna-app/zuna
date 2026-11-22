// Renders the iOS app icon from the desktop's, the white Z on black (icon.svg), as a full
// square (iOS rounds the corners itself) without an alpha channel, as the App Store requires.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, "..", "..", "desktop", "resources", "icon.svg"), "utf8").replace(/ r[xy]="[^"]*"/g, "");
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
// In a folder of its own, which nobody else can have put a file or a link in first.
const work = mkdtempSync(join(tmpdir(), "zuna-icon-"));
const rgba = join(work, "rgba.png");
const jpeg = join(work, "icon.jpg");
writeFileSync(rgba, png);
// A round trip through JPEG drops the alpha channel.
execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "100", rgba, "--out", jpeg], { stdio: "ignore" });
const out = join(here, "..", "Zuna", "Assets.xcassets", "AppIcon.appiconset", "icon-1024.png");
execFileSync("sips", ["-s", "format", "png", jpeg, "--out", out], { stdio: "ignore" });
rmSync(work, { recursive: true, force: true });
console.log(`> wrote ${out}`);
