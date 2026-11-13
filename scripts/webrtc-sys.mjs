// Fetches LiveKit's crates that Zuna patches, at the versions apps/desktop/Cargo.lock pins and
// checked against crates.io's SHA-256 for each, and applies Zuna's patch to each, which
// `[patch.crates-io]` in apps/desktop/Cargo.toml builds the app with:
//
// - webrtc-sys: lets AV1 go out end to end encrypted, and has every video the app sends offered
//   with a retransmission stream, which LiveKit's SDK leaves out (apps/desktop/patches/webrtc-sys.patch
//   says how);
// - livekit-signaling: tells the media server neither the system nor the device's model, which it
//   writes to its log ("Voice channels" in docs/SECURITY_DETAILS.md).
//
// Update a crate's version, its hash and its patch together, when LiveKit's crates move.
//
//   node scripts/webrtc-sys.mjs     fetches them into apps/desktop/.deps, as the app's scripts do first
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { nativeAppDeps } from "./ffmpeg.mjs";

const patches = resolve(import.meta.dirname, "..", "apps", "desktop", "patches");
const crates = [
  {
    name: "webrtc-sys",
    version: "0.3.53",
    sha256: "dbfe2c11c98bfd4839242abf9a4b8ddb16a7ff3cbf87416f40928a06886eb5c7",
    // Where the patch shows it reached what it was for.
    marks: [
      ["src/frame_cryptor.cpp", "Av1Envelope"],
      ["src/rtp_transceiver.cpp", '"rtx"'],
    ],
  },
  {
    name: "livekit-signaling",
    version: "0.1.9",
    sha256: "62ffccb3c6dcd01855b2eac592298919048ab261a19d52951c808769b7c9c5db",
    marks: [["src/lib.rs", "(String::new(), String::new(), String::new())"]],
    // And what it took out, which would otherwise still be sent.
    gone: [
      ["src/lib.rs", "os_info::get()"],
      ["src/lib.rs", "device_info::device_info()"],
      ["Cargo.toml", "[dependencies.os_info]"],
      ["Cargo.toml", "[dependencies.device-info]"],
    ],
  },
];

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Makes sure each patched crate is in `<depsDir>/<name>`, and says where webrtc-sys is. */
export async function ensureWebrtcSys(depsDir) {
  const dirs = [];
  for (const crate of crates) dirs.push(await ensureCrate(depsDir, crate));
  return dirs[0];
}

async function ensureCrate(depsDir, { name, version, sha256, marks, gone = [] }) {
  const patch = join(patches, `${name}.patch`);
  const dir = join(depsDir, name);
  const stamp = join(dir, ".zuna");
  // The crate's hash and the patch's: a new patch is applied to a fresh copy.
  const wanted = `${sha256} ${hash(readFileSync(patch))}`;
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === wanted) return dir;

  const url = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
  mkdirSync(depsDir, { recursive: true });
  const archive = join(depsDir, `${name}-${version}.crate`);
  if (!existsSync(archive) || hash(readFileSync(archive)) !== sha256) {
    console.log(`Downloading ${url}`);
    // Tried a few times, waiting longer each time, as scripts/ffmpeg.mjs does: one connection
    // to crates.io that timed out once failed a whole release.
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
        break;
      } catch (error) {
        const why = error.cause?.message ?? error.message;
        if (attempt === 5) throw new Error(`${url} couldn't be fetched: ${why}`);
        console.log(`${url}: ${why}, trying again`);
        await new Promise((done) => setTimeout(done, attempt * 5000));
      }
    }
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
  const unpackedCrate = join(unpacked, readdirSync(unpacked)[0]);
  // git apply works outside a repository, as a plain patch. Inside one, as .deps is, it would take
  // the patch's paths from the repository's top and skip them without a word, so it's kept from
  // looking past the crate for one.
  const env = { ...process.env, GIT_CEILING_DIRECTORIES: resolve(unpacked) };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  result = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", patch], { cwd: unpackedCrate, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Applying ${patch} to ${name} ${version} failed`);
  const has = (file, mark) => readFileSync(join(unpackedCrate, file), "utf8").includes(mark);
  if (!marks.every(([file, mark]) => has(file, mark)) || gone.some(([file, mark]) => has(file, mark))) {
    throw new Error(`${patch} didn't reach ${name} ${version}`);
  }
  renameSync(unpackedCrate, dir);
  rmSync(unpacked, { recursive: true, force: true });
  writeFileSync(stamp, wanted);
  return dir;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await ensureWebrtcSys(nativeAppDeps);
  console.log(`${crates.map(({ name }) => name).join(" and ")} are in ${nativeAppDeps}`);
}
