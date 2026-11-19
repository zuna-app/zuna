// Releases the native app, and the iPhone app to TestFlight with each nightly and to App Store Connect
// with each stable release: works out the next
// version from a changelog, tags it, and leaves the build and the publishing to
// .github/workflows/release.yml, which also calls this for what a release builds, is checked and
// signed with. docs/RELEASES.md says how it all fits together.
//
//   node scripts/release.mjs pending                         the commits since each channel's last release
//   node scripts/release.mjs nightly <notes> [--dry-run]     cuts a nightly from origin/main
//   node scripts/release.mjs stable <notes> [--dry-run] [--major]   cuts a stable release from main, or a
//                                                            patch from the newest line's branch, release/X.Y
//   node scripts/release.mjs owed [--hook]                   fails when pushed app commits have no nightly
//   node scripts/release.mjs keygen <stable|nightly> --out <folder> [--spare] [--pq]   makes an update signing key, Ed25519's or ML-DSA-65's
//
// And for the workflow:
//
//   node scripts/release.mjs plan <tag>          checks a pushed tag, and says what it releases and which apps it builds
//   node scripts/release.mjs manifest <folder>   writes update.json for the installers there and signs it with both keys
//   node scripts/release.mjs prune               deletes all but the newest nightlies
//
// The notes are a changelog: every commit since the last release, by its short hash, under one of
// three headings. The headings decide the version, so the two can't disagree.
//
//   ## New
//   - 1a2b3c4 desktop: added an update button
//   ## Fixed and changed
//   - 5d6e7f8 desktop: fixed a crash on quitting
//   ## Under the hood
//   - 9a8b7c6 docs: said how releases work

import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Where releases are published. */
export const REPOSITORY = "zuna-app/zuna";

/** The last commit before releases began. Nothing up to it is ever listed or released on its own. */
export const BEGAN = "2aeaa13904b8f7a66bb53d27791d068c51f77beb";

/** How many nightlies stay on the releases page. */
export const NIGHTLIES_KEPT = 30;

/**
 * What the native app is built from. A commit that touches none of it changes nothing in the
 * app, so it can only be "Under the hood", and cuts no nightly unless it changes the iPhone app
 * (IOS_PATHS). Add to it whenever the app starts being built from somewhere new.
 */
export const APP_PATHS = [
  "apps/desktop/",
  "packages/core/",
  // watch.html, the page a video watched together plays in, which the core bundle's build writes beside it.
  "packages/watch/",
  // The table of core methods plugins may call, which the core bundle's build writes beside it.
  "packages/plugin-sdk/src/",
  // The interface's languages, which the app is built with, and the lookups the core uses.
  "packages/i18n/locales/",
  "packages/i18n/src/",
  "crypto/",
  // The bundler and shims the app's core bundle is made with.
  "apps/ios/core-bundle/",
  "package.json",
  "package-lock.json",
  "scripts/windows-app.mjs",
  "scripts/linux-app.mjs",
  "scripts/linux-build-deps.sh",
  "scripts/macos-app.mjs",
  "scripts/macos-dist.mjs",
  "scripts/signing.mjs",
  "scripts/lib.mjs",
  "scripts/ffmpeg.mjs",
  "scripts/webrtc-sys.mjs",
  // TDLib, which the Telegram engine links.
  "scripts/tdlib.mjs",
  "scripts/release.mjs",
  ".github/workflows/release.yml",
];

/** Inside those, what never reaches a build: tests and checks. */
export const NOT_APP_PATHS = ["apps/desktop/test/", "packages/core/test/", "packages/watch/test/", "packages/watch/fake/", "packages/plugin-sdk/test/"];

/**
 * What the iPhone app is built from. A commit that touches any of it makes a nightly too, which
 * goes to TestFlight (scripts/ios-dist.mjs), and a stable release takes it to App Store Connect, for
 * the App Store. The version is the native app's, so in the changelog
 * such a commit is still only "Under the hood" unless it reaches the native app as well.
 */
export const IOS_PATHS = [
  "apps/ios/",
  "packages/core/",
  // The interface's languages, which the core bundle's build copies into the app, and the lookups the core uses.
  "packages/i18n/locales/",
  "packages/i18n/src/",
  // watch.html, the page a video watched together plays in, which the core bundle's build writes beside it.
  "packages/watch/",
  "crypto/",
  "package.json",
  "package-lock.json",
  "scripts/build-crypto-apple.mjs",
  "scripts/fetch-sqlite.mjs",
  // TDLib, which the iPhone app links in a build given Telegram's api_id.
  "scripts/tdlib.mjs",
  "scripts/check-ios.mjs",
  "scripts/lib.mjs",
  "scripts/check-ios-release.mjs",
  "scripts/ios-dist.mjs",
  "scripts/signing.mjs",
  "scripts/release.mjs",
  ".github/workflows/release.yml",
];

/** Inside those, what never reaches the iPhone app's build. */
export const NOT_IOS_PATHS = ["apps/ios/ZunaUITests/", "apps/ios/ZunaKit/Tests/", "apps/ios/scripts/", "packages/core/test/", "packages/watch/test/", "packages/watch/fake/"];

/** The crates whose version is kept the same as the root package.json's. */
const CRATES = ["apps/desktop", "apps/desktop/screenshare", "apps/desktop/watch", "apps/desktop/telegram", "apps/desktop/media-ffmpeg", "apps/desktop/test/driver", "crypto", "crypto/bindgen"];

/** The changelog's headings, and the level each one's commits count as. */
export const HEADINGS = [
  ["New", "minor"],
  ["Fixed and changed", "patch"],
  ["Under the hood", "build"],
];

const LEVELS = ["build", "patch", "minor", "major"];

/** What the commit that sets the version is called, which the script makes and classes itself. */
const VERSION_COMMIT = "release: numbered the next release ";

/** What the commit that gives a stable release a build number no nightly had is called, which the script makes too. */
const OWN_BUILD_COMMIT = "release: gave a build of its own to ";

// --- Versions ---

export function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) throw new Error(`"${text}" isn't a version like 1.2.3`);
  return match.slice(1).map(Number);
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** A version raised once: a build still raises the patch, as a release is at least that. */
export function bump(version, level) {
  const [major, minor, patch] = parseVersion(version);
  if (level === "major") return `${major + 1}.0.0`;
  if (level === "minor") return `${major}.${minor + 1}.0`;
  if (level === "patch" || level === "build") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`"${level}" isn't a level`);
}

export function highestLevel(levels) {
  return levels.reduce((highest, level) => (LEVELS.indexOf(level) > LEVELS.indexOf(highest) ? level : highest), "build");
}

/**
 * What the next release is called: the last stable's version raised once by the highest level
 * since it. `current` is what the files say, which remembers a level an earlier nightly already
 * raised it by. Until there's a stable release the files' version stands, and becomes it.
 */
export function nextVersion({ lastStable, current, level, closed = [] }) {
  if (!lastStable) return level === "major" ? bump(current, "major") : current;
  const raised = bump(lastStable, level);
  let version = compareVersions(raised, current) > 0 ? raised : current;
  // A line whose branch had a patch of its own takes no more releases from main, which hasn't those
  // commits, so main goes on to the next line.
  while (closed.includes(lineOf(version))) version = bump(version, "minor");
  return version;
}

/** A version's release line: 0.11 for 0.11.0 and each of its patches. */
export const lineOf = (version) => parseVersion(version).slice(0, 2).join(".");

/** The branch a line's stable releases are on, which holds the newest of them: release/0.11. */
export const branchOf = (version) => `release/${lineOf(version)}`;

/** The line a release branch is for, or null for any other branch. */
export function lineOfBranch(name) {
  const match = /^release\/(\d+\.\d+)$/.exec(name);
  return match ? match[1] : null;
}

/**
 * What a release cut from a line's branch is called: the next patch of the newest stable release,
 * which has to be that line's, as only the newest line is patched. A problem instead when it can't be one.
 */
export function patchVersion({ line, newestStable, level }) {
  if (!newestStable || lineOf(newestStable) !== line) {
    return { problem: `${newestStable ? `${newestStable} is out` : "There's no stable release yet"}, so release/${line} isn't the newest line. Only the newest line's branch takes patches.` };
  }
  if (level === "minor" || level === "major") return { problem: `A release from release/${line} only fixes what's out, so nothing in it goes under New. What's new is released from main.` };
  return { version: bump(newestStable, "patch") };
}

/** A release's tag, read: `v0.11.0` or `v0.11.0-nightly.1108`. Null for any other tag. */
export function parseTag(tag) {
  const match = /^v(\d+\.\d+\.\d+)(?:-nightly\.(\d+))?$/.exec(tag);
  if (!match) return null;
  return match[2] === undefined ? { tag, channel: "stable", version: match[1] } : { tag, channel: "nightly", version: match[1], build: Number(match[2]) };
}

/** What a release is called everywhere a person reads it, and in its installer's name. */
export function labelOf({ version, channel, build }) {
  return channel === "nightly" ? `${version}-nightly.${build}` : version;
}

export const tagOf = (release) => `v${labelOf(release)}`;

/** The installer's name on Windows. The app reads it from the manifest, never works it out. */
export const windowsInstaller = (release) => `Zuna-Native-Setup-${labelOf(release)}.exe`;

// --- The changelog ---

const within = (file, paths) => paths.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path));

/** Whether any of a commit's files is something the app is built from. */
export const reachesApp = (files) => files.some((file) => within(file, APP_PATHS) && !within(file, NOT_APP_PATHS));

/** Whether any of a commit's files is something the iPhone app is built from. */
export const reachesIos = (files) => files.some((file) => within(file, IOS_PATHS) && !within(file, NOT_IOS_PATHS));

export const isVersionCommit = (subject) => subject.startsWith(VERSION_COMMIT) || subject.startsWith(OWN_BUILD_COMMIT);

/** The notes' lines, as commits under headings, and whatever in them is neither. */
export function parseNotes(text) {
  const items = [];
  const problems = [];
  let heading = null;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const title = /^#{1,6}\s*(.+?)\s*$/.exec(line);
    if (title) {
      const known = HEADINGS.find(([name]) => name.toLowerCase() === title[1].toLowerCase());
      if (!known) problems.push(`Line ${index + 1}: "${title[1]}" isn't one of the headings, which are ${HEADINGS.map(([name]) => name).join(", ")}.`);
      heading = known ? known[0] : null;
      return;
    }
    const item = /^[-*]\s+`?([0-9a-f]{7,40})`?(?:\s|$)/.exec(line);
    if (!item) return void problems.push(`Line ${index + 1}: "${line}" is neither a heading nor a commit, as "- 1a2b3c4 its subject".`);
    if (!heading) return void problems.push(`Line ${index + 1}: ${item[1]} is under no heading.`);
    items.push({ heading, hash: item[1] });
  });
  return { items, problems };
}

/**
 * Sorts the commits since the last release under the notes' headings. Every commit has to be
 * named exactly once, and one that touches nothing the app is built from can only be under the
 * hood. The commits that set the version go there by themselves.
 */
export function classify(notes, commits) {
  const { items, problems } = parseNotes(notes);
  const placed = new Map();
  for (const { heading, hash } of items) {
    const matches = commits.filter((commit) => commit.hash.startsWith(hash));
    if (matches.length === 0) problems.push(`${hash} isn't a commit since the last release.`);
    else if (matches.length > 1) problems.push(`${hash} could be any of ${matches.length} commits. Write more of it.`);
    else if (placed.has(matches[0].hash)) problems.push(`${hash} is named twice.`);
    else placed.set(matches[0].hash, heading);
  }
  for (const commit of commits) {
    const short = commit.hash.slice(0, 7);
    if (isVersionCommit(commit.subject)) {
      placed.set(commit.hash, "Under the hood");
      continue;
    }
    const heading = placed.get(commit.hash);
    if (!heading) problems.push(`${short} "${commit.subject}" isn't in the notes.`);
    else if (heading !== "Under the hood" && !reachesApp(commit.files)) problems.push(`${short} "${commit.subject}" is under ${heading}, but touches nothing the app is built from. It goes under Under the hood.`);
  }
  const groups = HEADINGS.map(([name, level]) => ({ name, level, commits: commits.filter((commit) => placed.get(commit.hash) === name) }));
  const level = highestLevel(groups.filter((group) => group.commits.length > 0).map((group) => group.level));
  return { groups, level, problems };
}

/** The changelog as it's published: the tag's message, and the release's notes. */
export function renderNotes(groups) {
  return (
    groups
      .filter((group) => group.commits.length > 0)
      .map((group) => `## ${group.name}\n\n${group.commits.map((commit) => `- ${commit.hash.slice(0, 7)} ${commit.subject}`).join("\n")}`)
      .join("\n\n") + "\n"
  );
}

/** Which heading each commit named in a changelog is under, by the hash written there. */
export function headingsIn(notes) {
  return new Map(parseNotes(notes).items.map(({ heading, hash }) => [hash, heading]));
}

// --- What a release carries ---

/** The nightly tags to delete: all but the `keep` newest, by build number. */
export function prunable(tags, keep = NIGHTLIES_KEPT) {
  return tags
    .map(parseTag)
    .filter((release) => release?.channel === "nightly")
    .sort((a, b) => b.build - a.build)
    .slice(keep)
    .map((release) => release.tag);
}

/** The manifest an installed app reads to learn of an update, as the bytes that are signed. */
export function manifestOf({ version, build, channel, commit, files }) {
  const release = { version, build, channel };
  return JSON.stringify({ version, build, channel, tag: tagOf(release), commit, files }, null, 2) + "\n";
}

/** A new signing key: the private half as it's kept, and the public half as the app carries it. */
export function newKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { secret: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), public: publicOf(publicKey) };
}

/** A public key as the app carries it: its 32 bytes, in base64. */
function publicOf(key) {
  return Buffer.from(key.export({ format: "jwk" }).x, "base64url").toString("base64");
}

export function signWith(secret, bytes) {
  const key = createPrivateKey({ key: Buffer.from(secret.trim(), "base64"), format: "der", type: "pkcs8" });
  return { signature: sign(null, bytes, key).toString("base64"), public: publicOf(createPublicKey(key)) };
}

export function signedBy(publicKey, bytes, signature) {
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") }, format: "jwk" });
  return verify(null, bytes, key, Buffer.from(signature, "base64"));
}

// The second signature, update.json.sig2, is ML-DSA-65 (FIPS 204), which a quantum computer
// doesn't break as it would Ed25519 (docs/POST_QUANTUM.md). Its key is kept as the 32-byte seed
// FIPS 204 makes it from, and carried in the app as its 1,952-byte public key. Node signs with
// OpenSSL's ML-DSA, hedged, with an empty context, which crypto/src/hybrid.rs checks as the app does.

/** PKCS #8 for an ML-DSA-65 key given by its seed alone, which the seed follows. */
const ML_DSA_65_SEED = Buffer.from("3034020100300b060960864801650304031204228020", "hex");

function pqPrivate(secret) {
  const seed = Buffer.from(secret.trim(), "base64");
  if (seed.length !== 32) throw new Error("An ML-DSA-65 signing key is kept as its 32-byte seed.");
  return createPrivateKey({ key: Buffer.concat([ML_DSA_65_SEED, seed]), format: "der", type: "pkcs8" });
}

/** A public key as the app carries it: its 1,952 bytes, in base64. */
const pqPublicOf = (key) => Buffer.from(key.export({ format: "jwk" }).pub, "base64url").toString("base64");

/** A new ML-DSA-65 signing key: its seed as it's kept, and the public key as the app carries it. */
export function newPqKey() {
  const secret = randomBytes(32).toString("base64");
  return { secret, public: pqPublicOf(createPublicKey(pqPrivate(secret))) };
}

export function pqSignWith(secret, bytes) {
  const key = pqPrivate(secret);
  return { signature: sign(null, bytes, key).toString("base64"), public: pqPublicOf(createPublicKey(key)) };
}

export function pqSignedBy(publicKey, bytes, signature) {
  const key = createPublicKey({ key: { kty: "AKP", alg: "ML-DSA-65", pub: Buffer.from(publicKey, "base64").toString("base64url") }, format: "jwk" });
  return verify(null, bytes, key, Buffer.from(signature, "base64"));
}

/**
 * The public keys the app carries for each channel, read from its source: Ed25519's, and
 * ML-DSA-65's under `stablePq` and `nightlyPq`.
 */
export function appKeys(source) {
  const keys = {};
  for (const [channel, name] of [["stable", "STABLE_KEYS"], ["nightly", "NIGHTLY_KEYS"], ["stablePq", "STABLE_PQ_KEYS"], ["nightlyPq", "NIGHTLY_PQ_KEYS"]]) {
    const list = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(source);
    if (!list) throw new Error(`${name} isn't in the app's source`);
    keys[channel] = [...list[1].matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((match) => match[1]);
  }
  return keys;
}

// --- The version's files ---

/** The XcodeGen spec whose MARKETING_VERSION is the iPhone app's version, which App Store Connect closes once it's released. */
const IOS_SPEC = "apps/ios/project.yml";

/** Every file that says the version: the workspaces' package.json, their lock, the crates and theirs, and the iPhone app's spec. */
export function versionFiles(dir) {
  const packages = ["package.json"];
  for (const pattern of JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).workspaces) {
    const parent = pattern.replace(/\/\*$/, "");
    if (!existsSync(join(dir, parent))) continue;
    for (const name of readdirSync(join(dir, parent)).sort()) if (existsSync(join(dir, parent, name, "package.json"))) packages.push(`${parent}/${name}/package.json`);
  }
  const crates = CRATES.filter((crate) => existsSync(join(dir, crate, "Cargo.toml"))).map((crate) => `${crate}/Cargo.toml`);
  const locks = CRATES.filter((crate) => existsSync(join(dir, crate, "Cargo.lock"))).map((crate) => `${crate}/Cargo.lock`);
  const ios = existsSync(join(dir, IOS_SPEC)) ? [IOS_SPEC] : [];
  return { packages, crates, locks, ios };
}

/** Sets the version everywhere it's written, and says which files changed. */
export function setVersion(dir, version) {
  parseVersion(version);
  const { packages, crates, locks, ios } = versionFiles(dir);
  const changed = [];
  const rewrite = (file, change) => {
    const before = readFileSync(join(dir, file), "utf8");
    const after = change(before);
    if (after === before) return;
    writeFileSync(join(dir, file), after);
    changed.push(file);
  };
  for (const file of packages) rewrite(file, (text) => text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`));
  // The lock names the root and each workspace, which npm would write the same way.
  if (existsSync(join(dir, "package-lock.json"))) {
    rewrite("package-lock.json", (text) => {
      const crlf = text.includes("\r\n");
      const lock = JSON.parse(text);
      lock.version = version;
      for (const [path, entry] of Object.entries(lock.packages ?? {})) if (!path.includes("node_modules") && entry.version !== undefined) entry.version = version;
      const written = JSON.stringify(lock, null, 2) + "\n";
      return crlf ? written.replace(/\n/g, "\r\n") : written;
    });
  }
  const names = [];
  for (const file of crates) {
    rewrite(file, (text) => text.replace(/^(version\s*=\s*")[^"]*(")/m, `$1${version}$2`));
    names.push(/^name\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, file), "utf8"))[1]);
  }
  for (const file of locks) {
    rewrite(file, (text) => names.reduce((lock, name) => lock.replace(new RegExp(`(name = "${name}"\\r?\\nversion = ")[^"]*(")`), `$1${version}$2`), text));
  }
  for (const file of ios) rewrite(file, (text) => text.replace(/^(\s*MARKETING_VERSION:\s*")[^"]*(")/m, `$1${version}$2`));
  return changed;
}

/** The version the app is released with: the root package.json's. */
export function currentVersion(dir = root) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

// --- Git ---

function git(...args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) fail(`git isn't here: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(" ")} failed:\n${result.stderr.trim()}`);
  return result.stdout.trim();
}

const gitOk = (...args) => spawnSync("git", args, { cwd: root, stdio: "ignore" }).status === 0;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** How many commits a commit has behind it, itself included: its build number. */
const buildOf = (ref) => Number(git("rev-list", "--count", ref));

/** Fetches main, every release line's branch and the tags. */
const fetchReleases = () => git("fetch", "--quiet", "--tags", "origin", "main", "+refs/heads/release/*:refs/remotes/origin/release/*");

/** The newest stable release of any line, wherever its tag is, which every next version is raised from. */
function newestStable() {
  const stables = git("tag", "-l", "v*").split(/\r?\n/).map(parseTag).filter((release) => release?.channel === "stable");
  return stables.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}

/** The newest nightly, wherever its tag is. */
function newestNightly() {
  return git("tag", "-l", "v*-nightly.*").split(/\r?\n/).map(parseTag).filter((release) => release?.channel === "nightly").sort((a, b) => b.build - a.build)[0] ?? null;
}

/** The highest build any release has had, of either channel and any line. */
function highestBuild() {
  const releases = git("tag", "-l", "v*").split(/\r?\n/).map(parseTag).filter(Boolean);
  return Math.max(0, ...releases.map((release) => (release.channel === "nightly" ? release.build : buildOf(release.tag))));
}

/** The lines whose branch has commits `ref` hasn't, a patch of their own, so that main can't release in them any more. */
function closedLines(ref) {
  return git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/release/")
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((name) => lineOfBranch(name.replace(/^origin\//, "")) && !gitOk("merge-base", "--is-ancestor", name, ref))
    .map((name) => lineOfBranch(name.replace(/^origin\//, "")));
}

/** The newest stable release and the newest release of either kind that `ref` has behind it. */
function lastReleases(ref) {
  const tags = git("tag", "--merged", ref, "-l", "v*").split(/\r?\n/).map(parseTag).filter(Boolean);
  const stables = tags.filter((release) => release.channel === "stable").sort((a, b) => compareVersions(b.version, a.version));
  const stable = stables[0] ? { ...stables[0], build: buildOf(stables[0].tag) } : null;
  const nightly = tags.filter((release) => release.channel === "nightly").sort((a, b) => b.build - a.build)[0] ?? null;
  const newest = stable && (!nightly || stable.build >= nightly.build) ? stable : nightly;
  return { stable, newest };
}

/** The commits after `base` up to `ref`, oldest first, each with the files it touched. */
function commitsSince(base, ref) {
  const log = git("log", "--reverse", "--name-only", "--format=%x00%H%x09%s", `${base}..${ref}`);
  return log
    .split("\0")
    .filter((record) => record.trim())
    .map((record) => {
      const [first, ...rest] = record.split(/\r?\n/);
      const [hash, subject] = [first.slice(0, first.indexOf("\t")), first.slice(first.indexOf("\t") + 1)];
      return { hash, subject, files: rest.map((line) => line.trim()).filter(Boolean) };
    });
}

/** What a channel's next release would carry: where it starts from, the commits since, and which apps they change. */
function pendingFor(channel, ref) {
  const { stable, newest } = lastReleases(ref);
  const last = channel === "stable" ? stable : newest;
  const commits = commitsSince(last ? last.tag : BEGAN, ref);
  const counted = commits.filter((commit) => !isVersionCommit(commit.subject));
  return { last, stable, commits, reaches: counted.some((commit) => reachesApp(commit.files)), reachesIos: counted.some((commit) => reachesIos(commit.files)) };
}

/** What a channel's release builds, by which apps changed: a nightly takes the iPhone app to TestFlight, and a stable release to App Store Connect. */
export function changedApps({ reaches, reachesIos: ios }) {
  return [reaches && "the app", ios && "the iPhone app"].filter(Boolean);
}

const sentence = (text) => text[0].toUpperCase() + text.slice(1);

// --- Commands ---

/** Prints what a release would carry: each commit, what it reaches, and which heading a nightly already put it under. */
function report(title, pending, { files = false, known = new Map() } = {}) {
  const { last, commits } = pending;
  console.log(`\n${title}: ${commits.length} ${commits.length === 1 ? "commit" : "commits"} since ${last ? last.tag : "releases began"}`);
  for (const commit of commits) {
    const short = commit.hash.slice(0, 7);
    const reached = [reachesApp(commit.files) && "the app", reachesIos(commit.files) && "the iPhone app"].filter(Boolean);
    const marks = [isVersionCommit(commit.subject) ? "sets the version, needs no line" : reached.length > 0 ? `reaches ${reached.join(" and ")}` : "not in the app", known.get(short) && `was under ${known.get(short)}`].filter(Boolean);
    console.log(`  ${short} ${commit.subject}  [${marks.join(", ")}]`);
    if (files) for (const file of commit.files) console.log(`      ${file}`);
  }
  const changed = changedApps(pending);
  if (commits.length === 0) console.log("  Nothing to release.");
  else if (changed.length > 0) console.log(`  ${sentence(changed.join(" and "))} changed, so there's a release to cut.`);
  else console.log("  Nothing the app or the iPhone app is built from changed, so there's no release to cut.");
}

function pending() {
  fetchReleases();
  for (const channel of ["nightly", "stable"]) {
    // What nightlies since the last stable release already called each commit, where their tags are still here.
    const known = new Map();
    if (channel === "stable") {
      for (const tag of git("tag", "--merged", "origin/main", "-l", "v*-nightly.*").split(/\r?\n/).filter(Boolean)) {
        for (const [hash, heading] of headingsIn(git("tag", "-l", "--format=%(contents)", tag))) known.set(hash, heading);
      }
    }
    report(channel === "nightly" ? "Nightly" : "Stable", pendingFor(channel, "origin/main"), { files: channel === "nightly", known });
  }
  // A patch waiting on the newest line's branch, which is cut from there.
  const newest = newestStable();
  const branch = newest && branchOf(newest.version);
  if (branch && gitOk("rev-parse", "--verify", "--quiet", `origin/${branch}`)) {
    const waiting = pendingFor("stable", `origin/${branch}`);
    if (waiting.commits.length > 0) report(`A patch from ${branch}`, waiting, { files: true });
  }
}

function cut(channel, args) {
  const dryRun = args.includes("--dry-run");
  const major = args.includes("--major");
  const notesFile = args.find((arg) => !arg.startsWith("--"));
  if (!notesFile || !existsSync(notesFile)) fail(`Give the notes' file: npm run release:${channel} -- <notes file>`);
  if (major && channel !== "stable") fail("Only a stable release can be a major one.");

  fetchReleases();
  // Releases are cut from main, and a patch to what's out from its line's branch.
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const line = lineOfBranch(branch);
  if (branch !== "main" && !line) fail("Releases are cut from main, and a patch to what's out from its line's branch, release/X.Y.");
  if (line && channel !== "stable") fail("Nightlies are cut from main.");
  if (line && major) fail(`${branch} only takes patches. A major release is cut from main.`);
  if (git("status", "--porcelain", "--untracked-files=no")) fail("There are changes that aren't committed.");
  if (!gitOk("rev-parse", "--verify", "--quiet", `origin/${branch}`) || git("rev-parse", "HEAD") !== git("rev-parse", `origin/${branch}`)) {
    fail(`${branch} isn't at origin/${branch}. Pull and push first, so the release is what's on GitHub.`);
  }

  const pending = pendingFor(channel, "HEAD");
  const { last, commits } = pending;
  const { groups, level, problems } = classify(readFileSync(notesFile, "utf8"), commits);
  if (problems.length > 0) fail(`The notes don't match the ${commits.length} commits since ${last ? last.tag : "releases began"}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  const changed = changedApps(pending);
  if (changed.length === 0) {
    console.log(`Nothing the app or the iPhone app is built from changed since ${last ? last.tag : "releases began"}, so there's no ${channel} release to cut.`);
    return;
  }

  // Every version is raised from the newest stable release, wherever it was cut, so that main never
  // takes a number a patch on a line's branch already has.
  const current = currentVersion();
  const newest = newestStable()?.version ?? null;
  let version;
  if (line) {
    const patch = patchVersion({ line, newestStable: newest, level });
    if (patch.problem) fail(patch.problem);
    version = patch.version;
  } else {
    version = nextVersion({ lastStable: newest, current, level: major ? "major" : level, closed: closedLines("HEAD") });
  }
  const renumber = version !== current;
  // The commit that sets the version is one more, and the tag goes on it.
  let build = buildOf("HEAD") + (renumber ? 1 : 0);
  // An installed app only takes a higher build, so a release that would have none of its own gets
  // commits that give it one, which need no line in the notes.
  let own = 0;
  if (!line) {
    // From main, every release passes every release before it, of either channel and any line: a
    // stable release cut where the last nightly was, too, which TestFlight would refuse, as it takes
    // each build of a version once and a stable release always sends the iPhone app.
    const highest = highestBuild();
    if (build <= highest) [own, build] = [highest + 1 - build, highest + 1];
  } else {
    // A patch passes its line's releases by itself, but mustn't share a build with a nightly of its version, for TestFlight.
    while (gitOk("rev-parse", "--verify", "--quiet", `refs/tags/${tagOf({ version, channel: "nightly", build })}`)) [own, build] = [own + 1, build + 1];
    // An app on nightly takes the higher of the newest nightly and the newest stable release, so a
    // patch mustn't pass a nightly newer than its line's last release, which would take it back.
    const nightly = newestNightly();
    if (nightly && last && nightly.build > last.build && build >= nightly.build) {
      fail(`This patch would be build ${build}, past the newest nightly's ${nightly.build}, so an app on nightly would go back to it. Cut a nightly from main first, which passes it.`);
    }
  }
  const release = { version, channel, build };
  const tag = tagOf(release);
  if (gitOk("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) fail(`${tag} is there already. A tag is never moved or reused.`);
  // A stable release from main is the newest of its line, so its line's branch is made or moved up to it, with the tag.
  // A patch is on its line's branch already.
  const lineBranch = channel === "stable" && !line ? branchOf(version) : null;
  if (lineBranch && gitOk("rev-parse", "--verify", "--quiet", `origin/${lineBranch}`) && !gitOk("merge-base", "--is-ancestor", `origin/${lineBranch}`, "HEAD")) {
    fail(`${lineBranch} has commits main hasn't, so ${version} can't be released from main.`);
  }
  const notes = renderNotes(groups);

  console.log(`${channel === "nightly" ? "Nightly" : "Stable"} ${labelOf(release)}, build ${build}, from ${branch}: ${commits.length} ${commits.length === 1 ? "commit" : "commits"} since ${last ? last.tag : "releases began"}, the highest of them ${level}. They change ${changed.join(" and ")}.\n`);
  console.log(notes);
  if (dryRun) {
    const steps = [renumber && `the version would go from ${current} to ${version}`, own > 0 && `${own === 1 ? "a commit" : `${own} commits`} would give it a build of its own`, `${tag} would be pushed${lineBranch ? `, with ${lineBranch} at it` : ""}`].filter(Boolean);
    console.log(`A dry run: ${steps.join(", and ")}.`);
    return;
  }

  if (renumber) {
    const changed = setVersion(root, version);
    git("commit", "--quiet", "-m", `${VERSION_COMMIT}${version}`, "--", ...changed);
  }
  for (let i = 0; i < own; i++) git("commit", "--quiet", "--allow-empty", "-m", `${OWN_BUILD_COMMIT}${version}`);
  const added = (renumber ? 1 : 0) + own;
  if (added > 0) {
    const pushed = spawnSync("git", ["push", "--quiet", "origin", branch], { cwd: root, stdio: "inherit" });
    if (pushed.status !== 0) {
      // Someone pushed meanwhile, and their commits aren't in the notes: the numbering is undone.
      git("reset", "--quiet", "--hard", `HEAD~${added}`);
      fail(`${branch} moved while this ran. Pull, add the new commits to the notes and run it again.`);
    }
  }
  const message = join(git("rev-parse", "--absolute-git-dir"), "RELEASE_NOTES");
  writeFileSync(message, notes);
  git("tag", "-a", tag, "-F", message, "--cleanup=verbatim");
  // The tag and the line's branch go together, or neither does.
  const refs = [`refs/tags/${tag}`, ...(lineBranch ? [`HEAD:refs/heads/${lineBranch}`] : [])];
  const pushed = spawnSync("git", ["push", "--quiet", "--atomic", "origin", ...refs], { cwd: root, stdio: "inherit" });
  if (pushed.status !== 0) {
    git("tag", "-d", tag);
    fail(`${tag}${lineBranch ? ` and ${lineBranch}` : ""} weren't pushed${added > 0 ? `, though ${branch} has the numbering now` : ""}. Pull and run it again.`);
  }
  console.log(`Pushed ${tag}${lineBranch ? `, and ${lineBranch} at it` : ""}. The Release workflow builds and publishes it: gh run watch, or https://github.com/${REPOSITORY}/actions`);
}

/**
 * For the Stop hook: fails, saying what to do, while pushed commits that reach the app have no nightly. A nightly is cut
 * only when the person asks for one, so as the hook it holds a turn once for each commit, for Claude to ask them.
 */
function owed(args) {
  const hook = args.includes("--hook");
  if (hook) {
    // A turn that's already going on because of this hook ends, so it can't hold one forever.
    try {
      if (JSON.parse(readFileSync(0, "utf8")).stop_hook_active) return;
    } catch {
      // No input, or none that says.
    }
  }
  if (!gitOk("rev-parse", "--verify", "--quiet", "origin/main")) return;
  const { last, commits } = pendingFor("nightly", "origin/main");
  const waiting = commits.filter((commit) => !isVersionCommit(commit.subject) && (reachesApp(commit.files) || reachesIos(commit.files)));
  if (waiting.length === 0) return;
  if (hook) {
    // The commits a turn was held for already, kept in this checkout's git folder, so that what waits for the person's
    // word holds no turn after the one that asked.
    const asked = resolve(root, git("rev-parse", "--git-path", "zuna-nightly-asked"));
    const before = existsSync(asked) ? readFileSync(asked, "utf8").split(/\r?\n/) : [];
    if (waiting.every((commit) => before.includes(commit.hash))) return;
    writeFileSync(asked, `${waiting.map((commit) => commit.hash).join("\n")}\n`);
  }
  console.error(
    `${waiting.length} pushed ${waiting.length === 1 ? "commit changes" : "commits change"} the native app or the iPhone app since ${last ? last.tag : "releases began"}, with no nightly:\n` +
      waiting.map((commit) => `  ${commit.hash.slice(0, 7)} ${commit.subject}`).join("\n") +
      "\nA nightly is cut only when the person asks for one. Once the work is done and its checks pass, ask them, unless this turn did already, and only on their yes run npm run release:pending, then npm run release:nightly -- <notes file>, naming every commit it lists, other sessions' too (CLAUDE.md, \"Releases\").",
  );
  process.exit(2);
}

function keygen(args) {
  const channel = args.find((arg) => arg === "stable" || arg === "nightly");
  const out = args[args.indexOf("--out") + 1];
  const spare = args.includes("--spare");
  // The ML-DSA-65 key that signs update.json.sig2, beside the Ed25519 one that signs update.json.sig.
  const pq = args.includes("--pq");
  if (!channel || !args.includes("--out") || !out) fail("node scripts/release.mjs keygen <stable|nightly> --out <folder> [--spare] [--pq]");
  const file = join(resolve(out), `zuna-update-${channel}${spare ? "-spare" : ""}${pq ? "-pq" : ""}.key`);
  if (existsSync(file)) fail(`${file} is there already. A key is never made over another.`);
  const key = pq ? newPqKey() : newKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Zuna's ${pq ? "ML-DSA-65 " : ""}update signing key for ${channel}${spare ? ", the spare" : ""}. Whoever has this can sign updates: keep it offline.\n# Public: ${key.public}\n${key.secret}\n`, { mode: 0o600 });
  console.log(`Wrote the private key to ${file}. Move it somewhere offline.`);
  const secret = pq ? "UPDATE_SIGNING_KEY_PQ" : "UPDATE_SIGNING_KEY";
  if (!spare) {
    // Straight into its environment's secret, without showing it.
    const environment = channel === "stable" ? "release" : "nightly";
    const set = spawnSync("gh", ["secret", "set", secret, "--env", environment, "--repo", REPOSITORY], { input: key.secret, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
    if (set.status !== 0) fail(`gh couldn't set ${secret} in the ${environment} environment. Set it there by hand, to the last line of ${file}.`);
    console.log(`Set ${secret} in the ${environment} environment of ${REPOSITORY}.`);
  }
  const list = `${channel === "stable" ? "STABLE" : "NIGHTLY"}${pq ? "_PQ" : ""}_KEYS`;
  console.log(`The public key, for ${list} in apps/desktop/src/platform/updates.rs:\n${key.public}`);
}

/** The environment the iPhone app is signed and uploaded to App Store Connect in, for TestFlight and the App Store (scripts/ios-dist.mjs). */
export const TESTFLIGHT = "testflight";

/**
 * The commit an app last shipped from: the newest of its environments' deployments that
 * succeeded, which GitHub records for each job that runs in one. Null when there's none, or
 * when GitHub can't say.
 */
function lastShipped(environments) {
  const gh = (path, jq) => {
    const result = spawnSync("gh", ["api", path, "--jq", jq], { encoding: "utf8" });
    return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : null;
  };
  let newest = null;
  for (const environment of environments) {
    const deployments = gh(`repos/${REPOSITORY}/deployments?environment=${environment}&per_page=50`, ".[] | [.id, .sha] | @tsv");
    if (!deployments) {
      console.log(`GitHub didn't list the ${environment} environment's deployments, so it counts as having shipped nothing.`);
      return null;
    }
    for (const line of deployments) {
      const [id, sha] = line.split("\t");
      const states = gh(`repos/${REPOSITORY}/deployments/${id}/statuses?per_page=100`, ".[].state");
      if (!states) return null;
      if (!states.includes("success")) continue;
      if (gitOk("cat-file", "-e", `${sha}^{commit}`) && (!newest || buildOf(sha) > buildOf(newest))) newest = sha;
      break;
    }
  }
  return newest;
}

/** Whether anything an app is built from changed after the commit it last shipped from. Not knowing counts as changed. */
function changedSince(shipped, commit, reaches) {
  if (!shipped || !gitOk("merge-base", "--is-ancestor", shipped, commit)) return true;
  return commitsSince(shipped, commit).some((each) => !isVersionCommit(each.subject) && reaches(each.files));
}

/** In the workflow: refuses a tag that isn't a release as this script cuts one, and says what it releases. */
function plan(args) {
  const tag = args[0] ?? process.env.GITHUB_REF_NAME;
  const release = parseTag(tag ?? "");
  if (!release) fail(`${tag} isn't a release's tag.`);
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag") fail(`${tag} isn't an annotated tag, so it has no changelog.`);
  const commit = git("rev-list", "-n", "1", `refs/tags/${tag}`);
  // A nightly is on main, and a stable release on main or on its line's branch, where patches to what's out are cut.
  const on = (ref) => gitOk("rev-parse", "--verify", "--quiet", ref) && gitOk("merge-base", "--is-ancestor", commit, ref);
  const lineBranch = release.channel === "stable" ? branchOf(release.version) : null;
  if (!on("origin/main") && !(lineBranch && on(`origin/${lineBranch}`))) fail(lineBranch ? `${tag} is on neither main nor ${lineBranch}.` : `${tag} isn't on main.`);
  const version = JSON.parse(git("show", `${commit}:package.json`)).version;
  if (version !== release.version) fail(`${tag} is on a commit whose package.json says ${version}.`);
  const build = buildOf(commit);
  if (release.channel === "nightly" && release.build !== build) fail(`${tag} is on a commit that is build ${build}.`);
  // A stable release always has the installers, and the iPhone app for the App Store. A nightly
  // builds each app only if something it's built from changed since it last shipped, so one that
  // was cancelled or failed is made up for.
  const desktop = release.channel === "stable" || changedSince(lastShipped(["nightly", "release"]), commit, reachesApp);
  const ios = release.channel === "stable" || changedSince(lastShipped([TESTFLIGHT]), commit, reachesIos);
  const outputs = { channel: release.channel, version: release.version, build, label: labelOf({ ...release, build }), commit, environment: release.channel === "stable" ? "release" : "nightly", desktop, ios };
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}`).join("\n");
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`, { flag: "a" });
  console.log(lines);
}

/**
 * In the workflow: writes update.json for the installers in a folder, signs it with
 * UPDATE_SIGNING_KEY as update.json.sig and with UPDATE_SIGNING_KEY_PQ as update.json.sig2, and
 * lists every file's SHA-256. Builds from before the second check the first alone, and newer ones
 * both. Refuses when either key isn't one the app at this commit carries for the channel, as
 * nobody could install that update.
 */
function manifest(args) {
  const folder = resolve(args[0] ?? "");
  const { ZUNA_VERSION: version, ZUNA_CHANNEL: channel, ZUNA_BUILD: build, ZUNA_COMMIT: commit, UPDATE_SIGNING_KEY: secret, UPDATE_SIGNING_KEY_PQ: pqSecret } = process.env;
  if (!args[0] || !version || !channel || !build || !commit) fail("node scripts/release.mjs manifest <folder>, with ZUNA_VERSION, ZUNA_CHANNEL, ZUNA_BUILD and ZUNA_COMMIT set");
  if (!secret) fail("UPDATE_SIGNING_KEY isn't set, so the manifest can't be signed.");
  if (!pqSecret) fail("UPDATE_SIGNING_KEY_PQ isn't set, so the manifest can't be signed with ML-DSA-65.");
  const release = { version, channel, build: Number(build) };
  const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const files = {};
  const installer = join(folder, windowsInstaller(release));
  if (!existsSync(installer)) fail(`${installer} isn't there.`);
  files["windows-x86_64"] = { name: windowsInstaller(release), size: statSync(installer).size, sha256: sha256(installer) };
  const bytes = Buffer.from(manifestOf({ ...release, commit, files }));
  const signed = signWith(secret, bytes);
  const pqSigned = pqSignWith(pqSecret, bytes);
  const keys = appKeys(readFileSync(join(root, "apps", "desktop", "src", "platform", "updates.rs"), "utf8"));
  if (!keys[`${channel}Pq`].includes(pqSigned.public) || !pqSignedBy(pqSigned.public, bytes, pqSigned.signature)) {
    fail(`The ${channel} ML-DSA-65 key in this environment isn't one the app carries for ${channel}, so no installed app would take this update.`);
  }
  const carried = keys[channel];
  if (!carried.includes(signed.public) || !signedBy(signed.public, bytes, signed.signature)) fail(`The ${channel} key in this environment isn't one the app carries for ${channel}, so no installed app would take this update.`);
  writeFileSync(join(folder, "update.json"), bytes);
  writeFileSync(join(folder, "update.json.sig"), `${signed.signature}\n`);
  writeFileSync(join(folder, "update.json.sig2"), `${pqSigned.signature}\n`);
  const sums = readdirSync(folder).filter((name) => name !== "SHA256SUMS").sort().map((name) => `${sha256(join(folder, name))}  ${name}`);
  writeFileSync(join(folder, "SHA256SUMS"), `${sums.join("\n")}\n`);
  console.log(`Wrote and signed the manifest of ${labelOf(release)} in ${folder}.`);
}

/** In the workflow: deletes the nightlies past the newest, each with its tag. Stable releases stay. */
function prune() {
  const listed = spawnSync("gh", ["release", "list", "--repo", REPOSITORY, "--limit", "200", "--json", "tagName", "--jq", ".[].tagName"], { encoding: "utf8" });
  if (listed.status !== 0) fail(`gh couldn't list the releases:\n${listed.stderr}`);
  for (const tag of prunable(listed.stdout.split(/\r?\n/).filter(Boolean))) {
    const deleted = spawnSync("gh", ["release", "delete", tag, "--repo", REPOSITORY, "--cleanup-tag", "--yes"], { stdio: "inherit" });
    console.log(deleted.status === 0 ? `Deleted ${tag}.` : `Couldn't delete ${tag}.`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const commands = { pending, nightly: () => cut("nightly", args), stable: () => cut("stable", args), owed: () => owed(args), keygen: () => keygen(args), plan: () => plan(args), manifest: () => manifest(args), prune };
  if (!commands[command]) fail(`There's no command "${command ?? ""}" here. It takes ${Object.keys(commands).join(", ")}.`);
  commands[command]();
}
