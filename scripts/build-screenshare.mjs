// Builds the native screen capture for this system, and gathers what it needs into
// apps/screenshare/dist, which goes into installers. Without it, the native app
// can't share a screen on Windows or Linux, and a share from a Mac has no sound. On
// macOS it only takes the computer's sound, and only Macs with Apple silicon use it.
//
// It needs Rust and a C compiler, as well as: on Windows, Visual Studio's C++ build
// tools and a Rust MSVC toolchain (rustup toolchain install stable-x86_64-pc-windows-msvc);
// on Linux, clang, pkg-config and the glib and libva headers; on macOS, Xcode's command line
// tools. docs/SCREEN_SHARE.md has more.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ensureFfmpeg } from "./ffmpeg.mjs";
import { env, msvcToolchain, root, run } from "./lib.mjs";

if (process.platform !== "win32" && process.platform !== "linux" && process.platform !== "darwin") {
  console.log("Native screen capture is for Windows, Linux and macOS, so there's nothing to build here.");
  process.exit(0);
}

const isWindows = process.platform === "win32";
const crate = join(root, "apps", "screenshare");
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
  run("cargo", ["build", "--release", "--no-default-features"], { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target } });
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

const args = [...(isWindows ? [`+${msvcToolchain()}`] : []), "build", "--release"];
run("cargo", args, { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, ZUNA_FFMPEG_DIR: ffmpeg } });

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
// On Linux each only by the name it's loaded by, libavcodec.so.62, as copying the links
// beside it, libavcodec.so and libavcodec.so.62.28.103, copies the whole library each time.
const libraries = isWindows ? join(ffmpeg, "bin") : join(ffmpeg, "lib");
for (const name of readdirSync(libraries)) {
  if (isWindows ? /^(avcodec|avutil|swresample)-.*\.dll$/.test(name) : /^lib(avcodec|avfilter|avformat|avutil|swresample|swscale)\.so\.\d+$/.test(name)) copyFileSync(join(libraries, name), join(gathered, name));
}
if (existsSync(join(ffmpeg, "LICENSE.txt"))) copyFileSync(join(ffmpeg, "LICENSE.txt"), join(gathered, "FFMPEG-LICENSE.txt"));
swapIn(gathered);
