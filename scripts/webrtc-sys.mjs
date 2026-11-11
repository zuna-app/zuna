// Fetches LiveKit's webrtc-sys, at the version apps/desktop/Cargo.lock pins and checked against
// crates.io's SHA-256 for it, and applies Zuna's patch to it, which `[patch.crates-io]` in
// apps/desktop/Cargo.toml builds the app with. The patch lets AV1 go out end to end encrypted, and
// has every video the app sends offered with a retransmission stream, which LiveKit's SDK leaves
// out (apps/desktop/patches/webrtc-sys.patch says how). Update the version, its hash and the patch
// together, when LiveKit's crate moves.
//
//   node scripts/webrtc-sys.mjs     fetches it into apps/desktop/.deps, as the app's scripts do first
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { nativeAppDeps } from "./ffmpeg.mjs";

const version = "0.3.53";
const sha256 = "dbfe2c11c98bfd4839242abf9a4b8ddb16a7ff3cbf87416f40928a06886eb5c7";
const url = `https://static.crates.io/crates/webrtc-sys/webrtc-sys-${version}.crate`;
const patch = resolve(import.meta.dirname, "..", "apps", "desktop", "patches", "webrtc-sys.patch");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Makes sure the patched crate is in `<depsDir>/webrtc-sys`, and says where that is. */
export async function ensureWebrtcSys(depsDir) {
  const dir = join(depsDir, "webrtc-sys");
  const stamp = join(dir, ".zuna");
  // The crate's hash and the patch's: a new patch is applied to a fresh copy.
  const wanted = `${sha256} ${hash(readFileSync(patch))}`;
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === wanted) return dir;

  mkdirSync(depsDir, { recursive: true });
  const archive = join(depsDir, `webrtc-sys-${version}.crate`);
  if (!existsSync(archive) || hash(readFileSync(archive)) !== sha256) {
    console.log(`Downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  }
  const actual = hash(readFileSync(archive));
  if (actual !== sha256) {
    rmSync(archive);
    throw new Error(`${archive} has SHA-256 ${actual}, expected ${sha256}`);
  }

  const unpacked = `${dir}.unpacking`;
  rmSync(dir, { recursive: true, force: true });
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  // A .crate is a gzipped tarball, which every system's tar reads.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  let result = spawnSync(tar, ["-xzf", archive, "-C", unpacked], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Unpacking ${archive} failed`);
  const crate = join(unpacked, readdirSync(unpacked)[0]);
  // git apply works outside a repository, as a plain patch. Inside one, as .deps is, it would take
  // the patch's paths from the repository's top and skip them without a word, so it's kept from
  // looking past the crate for one.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: resolve(unpacked) };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  result = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", patch], { cwd: crate, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Applying ${patch} to webrtc-sys ${version} failed`);
  const reached = (file, mark) => readFileSync(join(crate, "src", file), "utf8").includes(mark);
  if (!reached("frame_cryptor.cpp", "Av1Envelope") || !reached("rtp_transceiver.cpp", '"rtx"')) {
    throw new Error(`${patch} didn't reach webrtc-sys ${version}`);
  }
  renameSync(crate, dir);
  rmSync(unpacked, { recursive: true, force: true });
  writeFileSync(stamp, wanted);
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`webrtc-sys is in ${await ensureWebrtcSys(nativeAppDeps)}`);
}
