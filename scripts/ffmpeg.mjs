// Fetches a pinned FFmpeg build, checked against its SHA-256. Native screen sharing
// encodes through it. Update a version and its hash together.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
};

async function download(url, file) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const partial = `${file}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, file);
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
  // Windows' own tar reads zip files, and the one Git Bash puts first on PATH doesn't.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  const result = spawnSync(tar, ["-xf", archive, "-C", unpacked], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Unpacking ${archive} failed`);
  renameSync(join(unpacked, readdirSync(unpacked)[0]), dir);
  rmSync(unpacked, { recursive: true, force: true });
  writeFileSync(stamp, entry.sha256);
  return dir;
}
