// Builds the native screen capture for this system, and gathers what it needs into
// apps/desktop/native/screenshare/dist, which goes into installers. A build of the app
// without it shares screens through Chromium instead, so this is optional. On macOS it
// only takes the computer's sound, and only Macs with Apple silicon use it.
//
// It needs Rust and a C compiler, as well as: on Windows, Visual Studio's C++ build
// tools and a Rust MSVC toolchain (rustup toolchain install stable-x86_64-pc-windows-msvc);
// on Linux, clang, pkg-config and the glib and libva headers; on macOS, Xcode's command line
// tools. docs/SCREEN_SHARE.md has more.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureFfmpeg } from "./ffmpeg.mjs";
import { env, root } from "./lib.mjs";

if (process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin") {
  console.log("Native screen capture is for Windows, Linux and macOS, so there's nothing to build here.");
  process.exit(0);
}

const isWindows = process.platform === "win32";
const crate = join(root, "apps", "desktop", "native", "screenshare");
const dist = join(crate, "dist");

/** Swaps a gathered build in, so whatever goes wrong leaves a whole one. */
function swapIn(gathered) {
  const previous = `${dist}-old`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(dist)) renameSync(dist, previous);
  renameSync(gathered, dist);
  try {
    rmSync(previous, { recursive: true, force: true });
  } catch {
    console.log("The last build is still running, so its folder stays until the next build.");
  }
  console.log(`Built native screen capture in ${dist}`);
}

// Only the computer's sound, which needs neither FFmpeg nor LiveKit.
if (process.platform === "darwin") {
  const target = join(crate, "target");
  const result = spawnSync("cargo", ["build", "--release", "--no-default-features"], { cwd: crate, stdio: "inherit", env: { ...env, CARGO_TARGET_DIR: target } });
  if (result.status !== 0) process.exit(result.status ?? 1);
  const gathered = `${dist}-new`;
  rmSync(gathered, { recursive: true, force: true });
  mkdirSync(gathered, { recursive: true });
  copyFileSync(join(target, "release", "zuna-screenshare"), join(gathered, "zuna-screenshare"));
  swapIn(gathered);
  process.exit(0);
}

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

// Gathered apart and swapped in, so whatever goes wrong leaves a whole build. The program may be
// running, which on Windows keeps it from being deleted but not moved, so it carries on from there.
const gathered = `${dist}-new`;
rmSync(gathered, { recursive: true, force: true });
mkdirSync(gathered, { recursive: true });
const release = join(target, "release");
for (const name of isWindows ? ["zuna-screenshare.exe", "zuna_encoder.dll"] : ["zuna-screenshare", "libzuna_encoder.so"]) {
  copyFileSync(join(release, name), join(gathered, name));
}
// Only what the encoder needs: FFmpeg's libraries that it links to, and those they link to.
const libraries = isWindows ? join(ffmpeg, "bin") : join(ffmpeg, "lib");
for (const name of readdirSync(libraries)) {
  if (isWindows ? /^(avcodec|avutil|swresample)-.*\.dll$/.test(name) : /\.so(\.\d+)*$/.test(name)) copyFileSync(join(libraries, name), join(gathered, name));
}
if (existsSync(join(ffmpeg, "LICENSE.txt"))) copyFileSync(join(ffmpeg, "LICENSE.txt"), join(gathered, "FFMPEG-LICENSE.txt"));
swapIn(gathered);
