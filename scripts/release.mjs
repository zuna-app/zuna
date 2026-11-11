// Releases the native app, and with each nightly the iPhone app to TestFlight: works out the next
// version from a changelog, tags it, and leaves the build and the publishing to
// .github/workflows/release.yml, which also calls this for what a release builds, is checked and
// signed with. docs/RELEASES.md says how it all fits together.
//
//   node scripts/release.mjs pending                         the commits since each channel's last release
//   node scripts/release.mjs nightly <notes> [--dry-run]     cuts a nightly from origin/main
//   node scripts/release.mjs stable <notes> [--dry-run] [--major]   cuts a stable release
//   node scripts/release.mjs owed [--hook]                   fails when pushed app commits have no nightly
//   node scripts/release.mjs keygen <stable|nightly> --out <folder> [--spare]   makes an update signing key
//
// And for the workflow:
//
//   node scripts/release.mjs plan <tag>          checks a pushed tag, and says what it releases and which apps it builds
//   node scripts/release.mjs manifest <folder>   writes and signs update.json for the installers there
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
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
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
  "scripts/release.mjs",
  ".github/workflows/release.yml",
];

/** Inside those, what never reaches a build: tests and checks. */
export const NOT_APP_PATHS = ["apps/desktop/test/", "packages/core/test/", "packages/watch/test/", "packages/watch/fake/"];

/**
 * What the iPhone app is built from. A commit that touches any of it makes a nightly too, which
 * goes to TestFlight (scripts/ios-dist.mjs). The version is the native app's, so in the changelog
 * such a commit is still only "Under the hood" unless it reaches the native app as well.
 */
export const IOS_PATHS = [
  "apps/ios/",
  "packages/core/",
  // watch.html, the page a video watched together plays in, which the core bundle's build writes beside it.
  "packages/watch/",
  "crypto/",
  "package.json",
  "package-lock.json",
  "scripts/build-crypto-apple.mjs",
  "scripts/fetch-sqlite.mjs",
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
const CRATES = ["apps/desktop", "apps/desktop/screenshare", "apps/desktop/media-ffmpeg", "apps/desktop/test/driver", "crypto", "crypto/bindgen"];

/** The changelog's headings, and the level each one's commits count as. */
export const HEADINGS = [
  ["New", "minor"],
  ["Fixed and changed", "patch"],
  ["Under the hood", "build"],
];

const LEVELS = ["build", "patch", "minor", "major"];

/** What the commit that sets the version is called, which the script makes and classes itself. */
const VERSION_COMMIT = "release: numbered the next release ";

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
export function nextVersion({ lastStable, current, level }) {
  if (!lastStable) return level === "major" ? bump(current, "major") : current;
  const raised = bump(lastStable, level);
  return compareVersions(raised, current) > 0 ? raised : current;
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

export const isVersionCommit = (subject) => subject.startsWith(VERSION_COMMIT);

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

/** The public keys the app carries for each channel, read from its source. */
export function appKeys(source) {
  const keys = {};
  for (const [channel, name] of [["stable", "STABLE_KEYS"], ["nightly", "NIGHTLY_KEYS"]]) {
    const list = new RegExp(`const ${name}: &\\[&str\\] = &\\[([^\\]]*)\\]`).exec(source);
    if (!list) throw new Error(`${name} isn't in the app's source`);
    keys[channel] = [...list[1].matchAll(/"([A-Za-z0-9+/=]+)"/g)].map((match) => match[1]);
  }
  return keys;
}

// --- The version's files ---

/** Every file that says the version: the workspaces' package.json, their lock, the crates and theirs. */
export function versionFiles(dir) {
  const packages = ["package.json"];
  for (const pattern of JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).workspaces) {
    const parent = pattern.replace(/\/\*$/, "");
    if (!existsSync(join(dir, parent))) continue;
    for (const name of readdirSync(join(dir, parent)).sort()) if (existsSync(join(dir, parent, name, "package.json"))) packages.push(`${parent}/${name}/package.json`);
  }
  const crates = CRATES.filter((crate) => existsSync(join(dir, crate, "Cargo.toml"))).map((crate) => `${crate}/Cargo.toml`);
  const locks = CRATES.filter((crate) => existsSync(join(dir, crate, "Cargo.lock"))).map((crate) => `${crate}/Cargo.lock`);
  return { packages, crates, locks };
}

/** Sets the version everywhere it's written, and says which files changed. */
export function setVersion(dir, version) {
  parseVersion(version);
  const { packages, crates, locks } = versionFiles(dir);
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

/** What a channel's release builds, by which apps changed: the iPhone app only goes out with nightlies. */
export function changedApps(channel, { reaches, reachesIos: ios }) {
  return [reaches && "the app", channel === "nightly" && ios && "the iPhone app"].filter(Boolean);
}

const sentence = (text) => text[0].toUpperCase() + text.slice(1);

// --- Commands ---

function pending() {
  git("fetch", "--quiet", "--tags", "origin", "main");
  for (const channel of ["nightly", "stable"]) {
    const pending = pendingFor(channel, "origin/main");
    const { last, commits } = pending;
    console.log(`\n${channel === "nightly" ? "Nightly" : "Stable"}: ${commits.length} ${commits.length === 1 ? "commit" : "commits"} since ${last ? last.tag : "releases began"}`);
    // What nightlies since the last stable release already called each commit, where their tags are still here.
    const known = new Map();
    if (channel === "stable") {
      for (const tag of git("tag", "--merged", "origin/main", "-l", "v*-nightly.*").split(/\r?\n/).filter(Boolean)) {
        for (const [hash, heading] of headingsIn(git("tag", "-l", "--format=%(contents)", tag))) known.set(hash, heading);
      }
    }
    for (const commit of commits) {
      const short = commit.hash.slice(0, 7);
      const reached = [reachesApp(commit.files) && "the app", reachesIos(commit.files) && "the iPhone app"].filter(Boolean);
      const marks = [isVersionCommit(commit.subject) ? "sets the version, needs no line" : reached.length > 0 ? `reaches ${reached.join(" and ")}` : "not in the app", known.get(short) && `was under ${known.get(short)}`].filter(Boolean);
      console.log(`  ${short} ${commit.subject}  [${marks.join(", ")}]`);
      if (channel === "nightly") for (const file of commit.files) console.log(`      ${file}`);
    }
    const changed = changedApps(channel, pending);
    if (commits.length === 0) console.log("  Nothing to release.");
    else if (changed.length > 0) console.log(`  ${sentence(changed.join(" and "))} changed, so there's a release to cut.`);
    else console.log(`  Nothing ${channel === "nightly" ? "the app or the iPhone app" : "the app"} is built from changed, so there's no release to cut.`);
  }
}

function cut(channel, args) {
  const dryRun = args.includes("--dry-run");
  const major = args.includes("--major");
  const notesFile = args.find((arg) => !arg.startsWith("--"));
  if (!notesFile || !existsSync(notesFile)) fail(`Give the notes' file: npm run release:${channel} -- <notes file>`);
  if (major && channel !== "stable") fail("Only a stable release can be a major one.");

  git("fetch", "--quiet", "--tags", "origin", "main");
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("Releases are cut from main.");
  if (git("status", "--porcelain", "--untracked-files=no")) fail("There are changes that aren't committed.");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("main isn't at origin/main. Pull and push first, so the release is what's on GitHub.");

  const pending = pendingFor(channel, "HEAD");
  const { last, stable, commits } = pending;
  const { groups, level, problems } = classify(readFileSync(notesFile, "utf8"), commits);
  if (problems.length > 0) fail(`The notes don't match the ${commits.length} commits since ${last ? last.tag : "releases began"}:\n${problems.map((problem) => `  ${problem}`).join("\n")}`);
  const changed = changedApps(channel, pending);
  if (changed.length === 0) {
    console.log(`Nothing ${channel === "nightly" ? "the app or the iPhone app" : "the app"} is built from changed since ${last ? last.tag : "releases began"}, so there's no ${channel} release to cut.`);
    return;
  }

  const current = currentVersion();
  const version = nextVersion({ lastStable: stable?.version ?? null, current, level: major ? "major" : level });
  const renumber = version !== current;
  // The commit that sets the version is one more, and the tag goes on it.
  const build = buildOf("HEAD") + (renumber ? 1 : 0);
  const release = { version, channel, build };
  const tag = tagOf(release);
  if (gitOk("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) fail(`${tag} is there already. A tag is never moved or reused.`);
  const notes = renderNotes(groups);

  console.log(`${channel === "nightly" ? "Nightly" : "Stable"} ${labelOf(release)}, build ${build}: ${commits.length} ${commits.length === 1 ? "commit" : "commits"} since ${last ? last.tag : "releases began"}, the highest of them ${level}. They change ${changed.join(" and ")}.\n`);
  console.log(notes);
  if (dryRun) {
    console.log(`A dry run: ${renumber ? `the version would go from ${current} to ${version}, and ` : ""}${tag} would be pushed.`);
    return;
  }

  if (renumber) {
    const changed = setVersion(root, version);
    git("commit", "--quiet", "-m", `${VERSION_COMMIT}${version}`, "--", ...changed);
    const pushed = spawnSync("git", ["push", "--quiet", "origin", "main"], { cwd: root, stdio: "inherit" });
    if (pushed.status !== 0) {
      // Someone pushed meanwhile, and their commits aren't in the notes: the numbering is undone.
      git("reset", "--quiet", "--hard", "HEAD~1");
      fail("main moved while this ran. Pull, add the new commits to the notes and run it again.");
    }
  }
  const message = join(git("rev-parse", "--absolute-git-dir"), "RELEASE_NOTES");
  writeFileSync(message, notes);
  git("tag", "-a", tag, "-F", message, "--cleanup=verbatim");
  git("push", "--quiet", "origin", `refs/tags/${tag}`);
  console.log(`Pushed ${tag}. The Release workflow builds and publishes it: gh run watch, or https://github.com/${REPOSITORY}/actions`);
}

/** For the Stop hook: fails, saying what to do, while pushed commits that reach the app have no nightly. */
function owed(args) {
  if (args.includes("--hook")) {
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
  console.error(
    `${waiting.length} pushed ${waiting.length === 1 ? "commit changes" : "commits change"} the native app or the iPhone app since ${last ? last.tag : "releases began"}, with no nightly:\n` +
      waiting.map((commit) => `  ${commit.hash.slice(0, 7)} ${commit.subject}`).join("\n") +
      "\nOnce the work is done and its checks pass, cut one: npm run release:pending, then npm run release:nightly -- <notes file> (CLAUDE.md, \"Releases\").",
  );
  process.exit(2);
}

function keygen(args) {
  const channel = args.find((arg) => arg === "stable" || arg === "nightly");
  const out = args[args.indexOf("--out") + 1];
  const spare = args.includes("--spare");
  if (!channel || !args.includes("--out") || !out) fail("node scripts/release.mjs keygen <stable|nightly> --out <folder> [--spare]");
  const file = join(resolve(out), `zuna-update-${channel}${spare ? "-spare" : ""}.key`);
  if (existsSync(file)) fail(`${file} is there already. A key is never made over another.`);
  const key = newKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# Zuna's update signing key for ${channel}${spare ? ", the spare" : ""}. Whoever has this can sign updates: keep it offline.\n# Public: ${key.public}\n${key.secret}\n`, { mode: 0o600 });
  console.log(`Wrote the private key to ${file}. Move it somewhere offline.`);
  if (!spare) {
    // Straight into its environment's secret, without showing it.
    const environment = channel === "stable" ? "release" : "nightly";
    const set = spawnSync("gh", ["secret", "set", "UPDATE_SIGNING_KEY", "--env", environment, "--repo", REPOSITORY], { input: key.secret, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
    if (set.status !== 0) fail(`gh couldn't set UPDATE_SIGNING_KEY in the ${environment} environment. Set it there by hand, to the last line of ${file}.`);
    console.log(`Set UPDATE_SIGNING_KEY in the ${environment} environment of ${REPOSITORY}.`);
  }
  console.log(`The public key, for ${channel === "stable" ? "STABLE_KEYS" : "NIGHTLY_KEYS"} in apps/desktop/src/platform/updates.rs:\n${key.public}`);
}

/** The environment the iPhone app is signed and uploaded to TestFlight in (scripts/ios-dist.mjs). */
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
  if (!gitOk("merge-base", "--is-ancestor", commit, "origin/main")) fail(`${tag} isn't on main.`);
  const version = JSON.parse(git("show", `${commit}:package.json`)).version;
  if (version !== release.version) fail(`${tag} is on a commit whose package.json says ${version}.`);
  const build = buildOf(commit);
  if (release.channel === "nightly" && release.build !== build) fail(`${tag} is on a commit that is build ${build}.`);
  // A stable release always has the installers. A nightly builds each app only if something it's
  // built from changed since it last shipped, so one that was cancelled or failed is made up for.
  const desktop = release.channel === "stable" || changedSince(lastShipped(["nightly", "release"]), commit, reachesApp);
  const ios = release.channel === "nightly" && changedSince(lastShipped([TESTFLIGHT]), commit, reachesIos);
  const outputs = { channel: release.channel, version: release.version, build, label: labelOf({ ...release, build }), commit, environment: release.channel === "stable" ? "release" : "nightly", desktop, ios };
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${value}`).join("\n");
  if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `${lines}\n`, { flag: "a" });
  console.log(lines);
}

/**
 * In the workflow: writes update.json for the installers in a folder, signs it with
 * UPDATE_SIGNING_KEY as update.json.sig, and lists every file's SHA-256. Refuses when the key
 * isn't one the app at this commit carries for the channel, as nobody could install that update.
 */
function manifest(args) {
  const folder = resolve(args[0] ?? "");
  const { ZUNA_VERSION: version, ZUNA_CHANNEL: channel, ZUNA_BUILD: build, ZUNA_COMMIT: commit, UPDATE_SIGNING_KEY: secret } = process.env;
  if (!args[0] || !version || !channel || !build || !commit) fail("node scripts/release.mjs manifest <folder>, with ZUNA_VERSION, ZUNA_CHANNEL, ZUNA_BUILD and ZUNA_COMMIT set");
  if (!secret) fail("UPDATE_SIGNING_KEY isn't set, so the manifest can't be signed.");
  const release = { version, channel, build: Number(build) };
  const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const files = {};
  const installer = join(folder, windowsInstaller(release));
  if (!existsSync(installer)) fail(`${installer} isn't there.`);
  files["windows-x86_64"] = { name: windowsInstaller(release), size: statSync(installer).size, sha256: sha256(installer) };
  const bytes = Buffer.from(manifestOf({ ...release, commit, files }));
  const signed = signWith(secret, bytes);
  const carried = appKeys(readFileSync(join(root, "apps", "desktop", "src", "platform", "updates.rs"), "utf8"))[channel];
  if (!carried.includes(signed.public) || !signedBy(signed.public, bytes, signed.signature)) fail(`The ${channel} key in this environment isn't one the app carries for ${channel}, so no installed app would take this update.`);
  writeFileSync(join(folder, "update.json"), bytes);
  writeFileSync(join(folder, "update.json.sig"), `${signed.signature}\n`);
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
