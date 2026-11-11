// Fetches a pinned FFmpeg build, checked against its SHA-256. The native app's screen share
// encodes through it on Windows and Linux, and its media goes through it on Linux and macOS.
// Update a version and its hash together. BtbN publishes no build for macOS, so there it's built
// from FFmpeg's own source tarball, whose hash is the one the release signing key signed (`.asc`
// beside it).
//
//   node scripts/ffmpeg.mjs     fetches it into apps/desktop/.deps, where the native app's build
//                               looks (apps/desktop/.cargo/config.toml), as its scripts do first
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/** Where the native app's build finds it, in `ffmpeg` inside. */
export const nativeAppDeps = resolve(import.meta.dirname, "..", "apps", "desktop", ".deps");

const tag = "autobuild-2026-10-31-12-59";
const build = "ffmpeg-n8.1.3-27-g8dca1586f4";
const builds = {
  win32: {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/${build}-win64-lgpl-shared-8.1.zip`,
    sha256: "5cef7bc48e513f3cee7c881e8b2999d835541edb1846c3e89443a67f8f8556ab",
  },
  linux: {
    url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/${tag}/${build}-linux64-lgpl-shared-8.1.tar.xz`,
    sha256: "493e89a48da02b9a7d217b60f7f60c3c917c9bed73459d8a106e5e987da082ef",
  },
  darwin: {
    url: "https://ffmpeg.org/releases/ffmpeg-8.1.3.tar.xz",
    sha256: "7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3",
    source: true,
  },
};

/**
 * FFmpeg built from its source on macOS, as the other systems' builds are: LGPL, as shared
 * libraries that name each other through @rpath, so they load from the app's bundle, with
 * VideoToolbox and AudioToolbox, and nothing else found on the machine by itself.
 */
function buildFromSource(source, dir) {
  const run = (program, args) => {
    const done = spawnSync(program, args, { cwd: source, stdio: ["ignore", "inherit", "inherit"] });
    if (done.status !== 0) throw new Error(`${program} ${args.join(" ")} failed in ${source}`);
  };
  console.log("Building FFmpeg from its source, which only happens once...");
  run("./configure", [
    `--prefix=${dir}`,
    "--install-name-dir=@rpath",
    "--enable-shared",
    "--disable-static",
    "--disable-programs",
    "--disable-doc",
    "--disable-network",
    "--disable-debug",
    "--disable-autodetect",
    "--enable-videotoolbox",
    "--enable-audiotoolbox",
    "--cc=clang",
  ]);
  const cores = spawnSync("sysctl", ["-n", "hw.ncpu"], { encoding: "utf8" }).stdout.trim() || "8";
  run("make", [`-j${cores}`]);
  run("make", ["install"]);
}

// Tried a few times, waiting longer each time: ffmpeg.org reset a runner's connection once, before
// a byte of it came.
async function download(url, file) {
  const partial = `${file}.partial`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
      renameSync(partial, file);
      return;
    } catch (error) {
      const why = error.cause?.message ?? error.message;
      if (attempt === 5) throw new Error(`${url} couldn't be fetched: ${why}`);
      console.log(`${url}: ${why}, trying again`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Makes sure this system's FFmpeg is in `<depsDir>/ffmpeg`, and says where that is. */
export async function ensureFfmpeg(depsDir) {
  const entry = builds[process.platform];
  if (!entry) throw new Error(`No FFmpeg build for ${process.platform}`);

  const dir = join(depsDir, "ffmpeg");
  const stamp = join(dir, ".sha256");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === entry.sha256) return dir;

  mkdirSync(depsDir, { recursive: true });
  const archive = join(depsDir, entry.url.split("/").pop());
  if (!existsSync(archive) || sha256(archive) !== entry.sha256) {
    console.log(`Downloading ${entry.url}`);
    await download(entry.url, archive);
  }
  const actual = sha256(archive);
  if (actual !== entry.sha256) {
    rmSync(archive);
    throw new Error(`${archive} has SHA-256 ${actual}, expected ${entry.sha256}`);
  }

  const unpacked = `${dir}.unpacking`;
  rmSync(dir, { recursive: true, force: true });
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  if (entry.source) {
    const result = spawnSync("tar", ["-xf", archive, "-C", unpacked], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Unpacking ${archive} failed`);
    buildFromSource(join(unpacked, readdirSync(unpacked)[0]), resolve(dir));
    rmSync(unpacked, { recursive: true, force: true });
    writeFileSync(stamp, entry.sha256);
    return dir;
  }
  // Windows' own tar reads zip files, and the one Git Bash puts first on PATH doesn't.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  const result = spawnSync(tar, ["-xf", archive, "-C", unpacked], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Unpacking ${archive} failed`);
  renameSync(join(unpacked, readdirSync(unpacked)[0]), dir);
  rmSync(unpacked, { recursive: true, force: true });
  writeFileSync(stamp, entry.sha256);
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`FFmpeg is in ${await ensureFfmpeg(nativeAppDeps)}`);
}
