// The parts of scripts/release.mjs nobody watches as it runs: version numbers, the changelog's
// rules, what's signed and what's deleted. Run with `npm run test:release`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { appKeys, bump, changedApps, classify, compareVersions, headingsIn, labelOf, manifestOf, newKey, nextVersion, parseNotes, parseTag, prunable, reachesApp, reachesIos, renderNotes, setVersion, signedBy, signWith, tagOf, versionFiles, windowsInstaller } from "./release.mjs";

const commit = (hash, subject, ...files) => ({ hash: hash.padEnd(40, "0"), subject, files });
const app = "apps/desktop/src/main.rs";

test("a version is raised once by a level", () => {
  assert.equal(bump("0.11.0", "minor"), "0.12.0");
  assert.equal(bump("0.11.4", "minor"), "0.12.0");
  assert.equal(bump("0.11.4", "patch"), "0.11.5");
  assert.equal(bump("0.11.4", "major"), "1.0.0");
  // A release is at least a patch.
  assert.equal(bump("0.11.0", "build"), "0.11.1");
  assert.throws(() => bump("0.11", "patch"));
  assert.throws(() => bump("0.11.0", "huge"));
});

test("versions compare as numbers", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("0.10.0", "0.10.0"), 0);
});

test("the next version follows the plan's example", () => {
  // After 0.11.0: a refactor, then a fix, a feature and another feature.
  const lastStable = "0.11.0";
  let current = "0.11.0";
  current = nextVersion({ lastStable, current, level: "build" });
  assert.equal(current, "0.11.1");
  current = nextVersion({ lastStable, current, level: "patch" });
  assert.equal(current, "0.11.1");
  current = nextVersion({ lastStable, current, level: "minor" });
  assert.equal(current, "0.12.0");
  current = nextVersion({ lastStable, current, level: "minor" });
  assert.equal(current, "0.12.0");
  // A later nightly of fixes alone doesn't take it back down.
  assert.equal(nextVersion({ lastStable, current, level: "patch" }), "0.12.0");
});

test("until the first stable release the version stands", () => {
  assert.equal(nextVersion({ lastStable: null, current: "0.10.0", level: "minor" }), "0.10.0");
  assert.equal(nextVersion({ lastStable: null, current: "0.10.0", level: "build" }), "0.10.0");
  assert.equal(nextVersion({ lastStable: null, current: "0.10.0", level: "major" }), "1.0.0");
});

test("a major release only comes when asked for", () => {
  assert.equal(nextVersion({ lastStable: "0.12.0", current: "0.12.1", level: "major" }), "1.0.0");
});

test("tags are read and written the same way", () => {
  assert.deepEqual(parseTag("v0.11.0"), { tag: "v0.11.0", channel: "stable", version: "0.11.0" });
  assert.deepEqual(parseTag("v0.11.0-nightly.1108"), { tag: "v0.11.0-nightly.1108", channel: "nightly", version: "0.11.0", build: 1108 });
  for (const other of ["0.11.0", "v0.11", "v0.11.0-beta.1", "v0.11.0-nightly", "v0.11.0-nightly.x", "vv0.11.0", "v0.11.0 "]) assert.equal(parseTag(other), null);
  assert.equal(tagOf({ version: "0.11.0", channel: "stable", build: 1200 }), "v0.11.0");
  assert.equal(tagOf({ version: "0.11.1", channel: "nightly", build: 1112 }), "v0.11.1-nightly.1112");
  assert.equal(labelOf({ version: "0.11.1", channel: "nightly", build: 1112 }), "0.11.1-nightly.1112");
  assert.equal(windowsInstaller({ version: "0.11.0", channel: "stable", build: 1200 }), "Zuna-Native-Setup-0.11.0.exe");
  assert.equal(windowsInstaller({ version: "0.11.1", channel: "nightly", build: 1112 }), "Zuna-Native-Setup-0.11.1-nightly.1112.exe");
});

test("only what the app is built from reaches it", () => {
  assert.ok(reachesApp(["apps/desktop/src/ui/rail.rs"]));
  assert.ok(reachesApp(["docs/ROADMAP.md", "packages/core/src/api.ts"]));
  assert.ok(reachesApp(["crypto/src/mls.rs"]));
  assert.ok(reachesApp(["package-lock.json"]));
  assert.ok(reachesApp([".github/workflows/release.yml"]));
  assert.ok(reachesApp(["scripts/linux-app.mjs"]));
  assert.ok(reachesApp(["scripts/linux-build-deps.sh"]));
  assert.ok(reachesApp(["apps/ios/core-bundle/src/crypto.ts"]));
  assert.ok(!reachesApp(["server/internal/api/server.go", "apps/web/src/main.tsx", "packages/ui/src/app.tsx"]));
  assert.ok(!reachesApp(["apps/ios/Zuna/App.swift", "apps/site/index.html", "docs/RELEASES.md", "CLAUDE.md"]));
  assert.ok(!reachesApp([".github/workflows/ci.yml", "scripts/build-web.mjs"]));
  // Tests and checks are in the app's folders, and in no build.
  assert.ok(!reachesApp(["apps/desktop/test/windows-update-check.mjs", "packages/core/test/security.test.ts"]));
  // A file that only starts with a listed file's name isn't it.
  assert.ok(!reachesApp(["package.json.bak", "scripts/lib.mjs.old"]));
  assert.ok(!reachesApp([]));
});

test("only what the iPhone app is built from reaches it", () => {
  assert.ok(reachesIos(["apps/ios/Zuna/Chat/ChatView.swift"]));
  assert.ok(reachesIos(["apps/ios/ZunaKit/Sources/ZunaHost/CryptoBridge.swift"]));
  assert.ok(reachesIos(["apps/ios/project.yml"]));
  assert.ok(reachesIos(["packages/core/src/session/session.ts"]));
  assert.ok(reachesIos(["packages/watch/src/sync.ts"]));
  assert.ok(reachesApp(["packages/watch/src/page.ts"]));
  assert.ok(!reachesApp(["packages/watch/fake/player.html"]));
  assert.ok(!reachesIos(["packages/watch/test/sync.test.ts", "packages/watch/fake/player.html"]));
  assert.ok(reachesIos(["crypto/src/native.rs"]));
  assert.ok(reachesIos(["scripts/build-crypto-apple.mjs"]));
  assert.ok(reachesIos(["scripts/ios-dist.mjs"]));
  assert.ok(!reachesIos(["apps/desktop/src/ui/rail.rs", "scripts/windows-app.mjs", "apps/web/src/main.tsx", "server/internal/api/server.go"]));
  // Its tests and the icon's tool are in its folder, and in no build.
  assert.ok(!reachesIos(["apps/ios/ZunaUITests/ChatTests.swift", "apps/ios/ZunaKit/Tests/ZunaHostTests/HostTests.swift", "apps/ios/scripts/make-icon.mjs", "packages/core/test/security.test.ts"]));
  assert.ok(!reachesIos([]));
});

test("a nightly builds whichever app changed, and a stable release only the native one", () => {
  assert.deepEqual(changedApps("nightly", { reaches: true, reachesIos: true }), ["the app", "the iPhone app"]);
  assert.deepEqual(changedApps("nightly", { reaches: false, reachesIos: true }), ["the iPhone app"]);
  assert.deepEqual(changedApps("nightly", { reaches: false, reachesIos: false }), []);
  assert.deepEqual(changedApps("stable", { reaches: true, reachesIos: true }), ["the app"]);
  assert.deepEqual(changedApps("stable", { reaches: false, reachesIos: true }), []);
});

test("a commit only in the iPhone app is still under the hood", () => {
  const commits = [commit("aaaaaaa", "ios: added a button", "apps/ios/Zuna/Chat/ChatView.swift")];
  assert.match(classify("## New\n- aaaaaaa\n", commits).problems[0], /touches nothing the app is built from/);
  assert.deepEqual(classify("## Under the hood\n- aaaaaaa\n", commits).problems, []);
});

test("the notes are commits under the three headings", () => {
  const { items, problems } = parseNotes("## New\n- 1a2b3c4 desktop: added a button\n\n### fixed and changed\n* `5d6e7f8`\n## Under the hood\n- 9a8b7c6d docs: said so\n");
  assert.deepEqual(problems, []);
  assert.deepEqual(items, [
    { heading: "New", hash: "1a2b3c4" },
    { heading: "Fixed and changed", hash: "5d6e7f8" },
    { heading: "Under the hood", hash: "9a8b7c6d" },
  ]);
});

test("anything else in the notes is refused", () => {
  assert.equal(parseNotes("- 1a2b3c4 before any heading\n").problems.length, 1);
  assert.equal(parseNotes("## Improvements\n- 1a2b3c4 x\n").problems.length, 2);
  assert.equal(parseNotes("## New\nsome words\n").problems.length, 1);
  assert.equal(parseNotes("## New\n- 1a2b3 too short\n").problems.length, 1);
});

test("the headings give the level", () => {
  const commits = [commit("aaaaaaa", "desktop: added a button", app), commit("bbbbbbb", "desktop: fixed a crash", app), commit("ccccccc", "docs: said so", "docs/x.md")];
  assert.equal(classify("## Under the hood\n- aaaaaaa\n- bbbbbbb\n- ccccccc\n", commits).level, "build");
  assert.equal(classify("## Fixed and changed\n- bbbbbbb\n## Under the hood\n- aaaaaaa\n- ccccccc\n", commits).level, "patch");
  const sorted = classify("## New\n- aaaaaaa\n## Fixed and changed\n- bbbbbbb\n## Under the hood\n- ccccccc\n", commits);
  assert.equal(sorted.level, "minor");
  assert.deepEqual(sorted.problems, []);
  assert.equal(renderNotes(sorted.groups), "## New\n\n- aaaaaaa desktop: added a button\n\n## Fixed and changed\n\n- bbbbbbb desktop: fixed a crash\n\n## Under the hood\n\n- ccccccc docs: said so\n");
});

test("every commit is named exactly once", () => {
  const commits = [commit("aaaaaaa", "desktop: added a button", app), commit("bbbbbbb", "desktop: fixed a crash", app)];
  const problems = (notes) => classify(notes, commits).problems;
  assert.match(problems("## New\n- aaaaaaa\n")[0], /bbbbbbb .* isn't in the notes/);
  assert.match(problems("## New\n- aaaaaaa\n- aaaaaaa\n- bbbbbbb\n")[0], /named twice/);
  assert.match(problems("## New\n- aaaaaaa\n- bbbbbbb\n- 1234567\n")[0], /isn't a commit since the last release/);
  assert.deepEqual(problems("## New\n- aaaaaaa\n## Fixed and changed\n- bbbbbbb\n"), []);
});

test("a short hash that could be two commits is refused", () => {
  const commits = [commit("abcdef1", "desktop: one", app), commit("abcdef2", "desktop: two", app)];
  assert.match(classify("## New\n- abcdef1\n- abcdef2\n", commits).problems.join(), /^$/);
  const alike = [{ hash: "abcdef1".padEnd(40, "1"), subject: "desktop: one", files: [app] }, { hash: "abcdef1".padEnd(40, "2"), subject: "desktop: two", files: [app] }];
  assert.match(classify("## New\n- abcdef1\n", alike).problems[0], /could be any of 2 commits/);
});

test("what doesn't reach the app is only ever under the hood", () => {
  const commits = [commit("aaaaaaa", "web: added a button", "packages/ui/src/app.tsx")];
  assert.match(classify("## New\n- aaaaaaa\n", commits).problems[0], /touches nothing the app is built from/);
  assert.deepEqual(classify("## Under the hood\n- aaaaaaa\n", commits).problems, []);
});

test("the commit that sets the version needs no line", () => {
  const commits = [commit("aaaaaaa", "desktop: fixed a crash", app), commit("bbbbbbb", "release: numbered the next release 0.11.1", "package.json")];
  const sorted = classify("## Fixed and changed\n- aaaaaaa\n", commits);
  assert.deepEqual(sorted.problems, []);
  assert.equal(sorted.level, "patch");
  assert.equal(sorted.groups[2].commits[0].subject, "release: numbered the next release 0.11.1");
});

test("a published changelog reads back as it was written", () => {
  const commits = [commit("aaaaaaa", "desktop: added a button", app), commit("ccccccc", "docs: said so", "docs/x.md")];
  const notes = renderNotes(classify("## New\n- aaaaaaa\n## Under the hood\n- ccccccc\n", commits).groups);
  assert.deepEqual([...headingsIn(notes)], [["aaaaaaa", "New"], ["ccccccc", "Under the hood"]]);
  assert.deepEqual(classify(notes, commits).problems, []);
});

test("only the nightlies past the newest are deleted", () => {
  const tags = ["v0.10.0", "v0.10.1-nightly.5", "v0.10.1-nightly.12", "v0.10.1-nightly.7", "v0.11.0", "v0.11.1-nightly.20", "something-else"];
  assert.deepEqual(prunable(tags, 2), ["v0.10.1-nightly.7", "v0.10.1-nightly.5"]);
  assert.deepEqual(prunable(tags, 30), []);
  assert.deepEqual(prunable(tags, 0), ["v0.11.1-nightly.20", "v0.10.1-nightly.12", "v0.10.1-nightly.7", "v0.10.1-nightly.5"]);
});

test("a manifest is signed by the key the app carries, and by no other", () => {
  const [key, other] = [newKey(), newKey()];
  const bytes = Buffer.from(manifestOf({ version: "0.11.1", build: 1112, channel: "nightly", commit: "c".repeat(40), files: { "windows-x86_64": { name: "Zuna-Native-Setup-0.11.1-nightly.1112.exe", size: 3, sha256: "a".repeat(64) } } }));
  const parsed = JSON.parse(bytes);
  assert.equal(parsed.tag, "v0.11.1-nightly.1112");
  assert.equal(parsed.build, 1112);
  const signed = signWith(key.secret, bytes);
  assert.equal(signed.public, key.public);
  assert.equal(Buffer.from(key.public, "base64").length, 32);
  assert.equal(Buffer.from(signed.signature, "base64").length, 64);
  assert.ok(signedBy(key.public, bytes, signed.signature));
  assert.ok(!signedBy(other.public, bytes, signed.signature));
  assert.ok(!signedBy(key.public, Buffer.concat([bytes, Buffer.from(" ")]), signed.signature));
});

test("the app's keys are read from its source", () => {
  const source = `pub const STABLE_KEYS: &[&str] = &[\n    // The key in use.\n    "AAAA+/8=",\n    "BBBB",\n];\npub const NIGHTLY_KEYS: &[&str] = &["CCCC"];\n`;
  assert.deepEqual(appKeys(source), { stable: ["AAAA+/8=", "BBBB"], nightly: ["CCCC"] });
  assert.deepEqual(appKeys("const STABLE_KEYS: &[&str] = &[];\nconst NIGHTLY_KEYS: &[&str] = &[];"), { stable: [], nightly: [] });
  assert.throws(() => appKeys("nothing"));
});

test("the version is set everywhere it's written, and nowhere else", () => {
  const dir = mkdtempSync(join(tmpdir(), "zuna-release-"));
  const write = (file, text) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  };
  const read = (file) => readFileSync(join(dir, file), "utf8");
  try {
    write("package.json", JSON.stringify({ name: "zuna", version: "0.10.0", workspaces: ["packages/*", "apps/*"], devDependencies: { other: "0.10.0" } }, null, 2) + "\n");
    write("packages/core/package.json", '{\r\n  "name": "@zuna/core",\r\n  "version": "0.10.0",\r\n  "dependencies": { "x": "0.10.0" }\r\n}\r\n');
    write("apps/notes.txt", "not a package");
    write("package-lock.json", JSON.stringify({ name: "zuna", version: "0.10.0", packages: { "": { name: "zuna", version: "0.10.0" }, "packages/core": { name: "@zuna/core", version: "0.10.0" }, "node_modules/other": { version: "0.10.0" } } }, null, 2) + "\n");
    write("crypto/Cargo.toml", '[package]\nname = "zuna-crypto"\nversion = "0.10.0"\n\n[dependencies]\nother = { version = "0.10.0" }\n');
    write("crypto/Cargo.lock", '[[package]]\nname = "other"\nversion = "0.10.0"\n\n[[package]]\nname = "zuna-crypto"\nversion = "0.10.0"\ndependencies = [\n "other",\n]\n');
    assert.deepEqual(versionFiles(dir), { packages: ["package.json", "packages/core/package.json"], crates: ["crypto/Cargo.toml"], locks: ["crypto/Cargo.lock"] });
    assert.deepEqual(setVersion(dir, "0.11.0").sort(), ["crypto/Cargo.lock", "crypto/Cargo.toml", "package-lock.json", "package.json", "packages/core/package.json"]);
    assert.equal(JSON.parse(read("package.json")).version, "0.11.0");
    assert.equal(JSON.parse(read("package.json")).devDependencies.other, "0.10.0");
    assert.equal(read("packages/core/package.json"), '{\r\n  "name": "@zuna/core",\r\n  "version": "0.11.0",\r\n  "dependencies": { "x": "0.10.0" }\r\n}\r\n');
    const lock = JSON.parse(read("package-lock.json"));
    assert.deepEqual([lock.version, lock.packages[""].version, lock.packages["packages/core"].version, lock.packages["node_modules/other"].version], ["0.11.0", "0.11.0", "0.11.0", "0.10.0"]);
    assert.equal(read("crypto/Cargo.toml"), '[package]\nname = "zuna-crypto"\nversion = "0.11.0"\n\n[dependencies]\nother = { version = "0.10.0" }\n');
    assert.equal(read("crypto/Cargo.lock"), '[[package]]\nname = "other"\nversion = "0.10.0"\n\n[[package]]\nname = "zuna-crypto"\nversion = "0.11.0"\ndependencies = [\n "other",\n]\n');
    // Set to what it is already, nothing changes.
    assert.deepEqual(setVersion(dir, "0.11.0"), []);
    assert.throws(() => setVersion(dir, "0.11"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
