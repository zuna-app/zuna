// Renders the iOS app icon from the desktop's, the white Z on black (icon.svg), as a full
// square (iOS rounds the corners itself) without an alpha channel, as the App Store requires.

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, "..", "..", "desktop", "resources", "icon.svg"), "utf8").replace(/ r[xy]="[^"]*"/g, "");
const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
const rgba = join(tmpdir(), "zuna-icon-rgba.png");
const jpeg = join(tmpdir(), "zuna-icon.jpg");
writeFileSync(rgba, png);
// A round trip through JPEG drops the alpha channel.
execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "100", rgba, "--out", jpeg], { stdio: "ignore" });
const out = join(here, "..", "Zuna", "Assets.xcassets", "AppIcon.appiconset", "icon-1024.png");
execFileSync("sips", ["-s", "format", "png", jpeg, "--out", out], { stdio: "ignore" });
rmSync(rgba);
rmSync(jpeg);
console.log(`> wrote ${out}`);
