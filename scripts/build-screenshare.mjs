// Builds the native screen capture for this system, and gathers what it needs into
// apps/desktop/native/screenshare/dist, which goes into installers. A build of the app
// without it shares screens through Chromium instead, so this is optional.
//
// It needs Rust and a C compiler, as well as: on Windows, Visual Studio's C++ build
// tools and a Rust MSVC toolchain (rustup toolchain install stable-x86_64-pc-windows-msvc);
// on Linux, clang, pkg-config and the glib and libva headers. docs/SCREEN_SHARE.md has more.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureFfmpeg } from "./ffmpeg.mjs";
import { env, root } from "./lib.mjs";

if (process.platform !== "win32" && process.platform !== "linux") {
  console.log("Native screen capture is for Windows and Linux, so there's nothing to build here.");
  process.exit(0);
}

const isWindows = process.platform === "win32";
const crate = join(root, "apps", "desktop", "native", "screenshare");
const dist = join(crate, "dist");
const ffmpeg = await ensureFfmpeg(join(crate, ".deps"));
// cl.exe can't open paths over 260 characters, and LiveKit's headers go past that
// from a target folder this deep in a checkout.
const target = isWindows ? join(process.env.LOCALAPPDATA, "zss") : join(crate, "target");

function msvcToolchain() {
  const list = spawnSync("rustup", ["toolchain", "list"], { encoding: "utf8", env }).stdout ?? "";
  const found = list.split("\n").map((line) => line.split(" ")[0]).find((name) => name.endsWith("-pc-windows-msvc"));
  if (!found) {
    console.error("Building on Windows needs a Rust MSVC toolchain: rustup toolchain install stable-x86_64-pc-windows-msvc");
    process.exit(1);
  }
  return found;
}

const args = [...(isWindows ? [`+${msvcToolchain()}`] : []), "build", "--release"];
const result = spawnSync("cargo", args, { cwd: crate, stdio: "inherit", env: { ...env, CARGO_TARGET_DIR: target, ZUNA_FFMPEG_DIR: ffmpeg } });
if (result.status !== 0) process.exit(result.status ?? 1);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
const release = join(target, "release");
for (const name of isWindows ? ["zuna-screenshare.exe", "zuna_encoder.dll"] : ["zuna-screenshare", "libzuna_encoder.so"]) {
  copyFileSync(join(release, name), join(dist, name));
}
// Only what the encoder needs: FFmpeg's libraries that it links to, and those they link to.
const libraries = isWindows ? join(ffmpeg, "bin") : join(ffmpeg, "lib");
for (const name of readdirSync(libraries)) {
  if (isWindows ? /^(avcodec|avutil|swresample)-.*\.dll$/.test(name) : /\.so(\.\d+)*$/.test(name)) copyFileSync(join(libraries, name), join(dist, name));
}
if (existsSync(join(ffmpeg, "LICENSE.txt"))) copyFileSync(join(ffmpeg, "LICENSE.txt"), join(dist, "FFMPEG-LICENSE.txt"));
console.log(`Built native screen capture in ${dist}`);
