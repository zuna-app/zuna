// Builds or runs the native app (apps/desktop) on macOS, on Apple silicon. It bundles the
// client core for QuickJS first, as scripts/windows-app.mjs does, builds with whichever Rust is
// installed, and wraps the program in an app bundle, since macOS only asks for the microphone,
// the camera, notifications and the computer's sound on behalf of a bundle, and keeps the
// answers, and the Keychain's trust, by its signature. So it's signed with this Mac's Apple
// Development identity, which stays the same from one build to the next, under the hardened
// runtime a release has, so that whatever the runtime refuses shows in development first.
//
//   node scripts/macos-app.mjs run [--release] [--test-control] [-- app args]
//                                   build it, then start it as macOS starts an app, with `open`
//   node scripts/macos-app.mjs build
//                                   a release build in dist/macos/Zuna.app
//   node scripts/macos-app.mjs dist
//                                   that, signed with the keychain's Developer ID, notarized and
//                                   stapled, with a DMG and a zip of it beside it
//   node scripts/macos-app.mjs bundle [--release] [--test-control]
//                                   a development build's bundle, not started, for the checks
//
// A development build is "Zuna Dev", chat.zuna.desktop.dev, apart from a release's
// permissions, and keeps its data in .dev-data/native-app, so that `npm run dev:clean` starts
// it over with the test server. ZUNA_DATA_DIR
// puts it elsewhere. --test-control builds in the checks' socket (src/test_control.rs).
//
// The private keys stay in the keychain, which signs for codesign, and notarizing takes the
// credentials `xcrun notarytool store-credentials zuna-notary` saved there, by that name only.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureFfmpeg } from "./ffmpeg.mjs";
import { appVersion as version, bundleCore, devNativeAppData, env, ensureNativeScreenCurrent, parseAppArgs, root, run } from "./lib.mjs";

const { command, flags, appArgs } = parseAppArgs("darwin", ["run", "build", "dist", "bundle"]);
const release = command === "build" || command === "dist" || flags.includes("--release");
const testControl = flags.includes("--test-control");

const crate = join(root, "apps", "desktop");
// Outside the checkout, as the other systems' builds keep theirs, and kept between checkouts.
const target = join(homedir(), "Library", "Caches", "zuna-desktop-target");
const notaryProfile = "zuna-notary";

// A release people download is signed with the Developer ID, as only that can be notarized.
const developerId = command === "dist" ? identity("Developer ID Application") : null;
if (command === "dist" && !developerId) {
  console.error("There's no Developer ID Application identity in the keychain to sign a release with. Import its certificate with the private key, from a .p12, first.");
  process.exit(1);
}

// The bundle carries the share's sound program from apps/screenshare/dist, so an old one would go in after a pull.
ensureNativeScreenCurrent();

/** GPUI compiles its Metal shaders as it builds, which Xcode 26 and later only can once asked. */
function checkMetal() {
  const metal = spawnSync("xcrun", ["metal", "--version"], { encoding: "utf8" });
  if (metal.status === 0) return;
  console.error("GPUI needs Xcode's Metal Toolchain to build its shaders. Download it once with:\n\n  xcodebuild -downloadComponent MetalToolchain\n");
  process.exit(1);
}

/** The keychain's signing identity of a kind, such as "Apple Development", by its hash, or null. */
function identity(kind) {
  const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).stdout ?? "";
  const line = found.split("\n").find((entry) => entry.includes(`"${kind}:`));
  return line?.match(/\b([0-9A-F]{40})\b/)?.[1] ?? null;
}

/** The app's icon, from the desktop's own sizes, as macOS takes it from a bundle. */
function icns(resources) {
  const icons = join(root, "apps", "desktop", "resources", "icons");
  const set = join(resources, "zuna.iconset");
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  for (const [name, size] of [
    ["16x16", 16],
    ["16x16@2x", 32],
    ["32x32", 32],
    ["32x32@2x", 64],
    ["128x128", 128],
    ["128x128@2x", 256],
    ["256x256", 256],
    ["256x256@2x", 512],
    ["512x512", 512],
  ]) {
    copyFileSync(join(icons, `${size}x${size}.png`), join(set, `icon_${name}.png`));
  }
  const made = spawnSync("iconutil", ["-c", "icns", set, "-o", join(resources, "zuna.icns")], { stdio: "inherit" });
  rmSync(set, { recursive: true, force: true });
  if (made.status !== 0) throw new Error("iconutil couldn't make the icon");
}

/** Plist XML for a value of strings, booleans, arrays and objects. */
function plist(value, indent = "") {
  if (typeof value === "boolean") return `${indent}<${value}/>`;
  if (Array.isArray(value)) return `${indent}<array>\n${value.map((item) => plist(item, `${indent}  `)).join("\n")}\n${indent}</array>`;
  if (typeof value === "object") {
    const entries = Object.entries(value).map(([key, item]) => `${indent}  <key>${key}</key>\n${plist(item, `${indent}  `)}`);
    return `${indent}<dict>\n${entries.join("\n")}\n${indent}</dict>`;
  }
  const text = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `${indent}<string>${text}</string>`;
}

/** A plist file's whole text, as Info.plist and entitlements are written. */
function plistFile(value) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plist(value)}\n</plist>\n`;
}

/** Writes entitlements for codesign where the build keeps its files, and gives their path. */
function entitlements(name, value) {
  const path = join(target, `${name}.entitlements`);
  writeFileSync(path, plistFile(value));
  return path;
}

/**
 * Wraps the program in an app bundle, with the screen capture beside it once it's built, and
 * signs it, with the Developer ID when it's given and the Apple Development identity otherwise.
 */
function bundle(program, media, out, { name, id, developerId = null }) {
  const app = join(out, `${name}.app`);
  rmSync(app, { recursive: true, force: true });
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  copyFileSync(program, join(macos, "zuna"));
  chmodSync(join(macos, "zuna"), 0o755);
  const screenshare = join(root, "apps", "screenshare", "dist", "zuna-screenshare");
  if (existsSync(screenshare)) copyFileSync(screenshare, join(macos, "zuna-screenshare"));
  else if (name === "Zuna") console.warn("> no native screen capture to put in: npm run build:screenshare first, or this build's shares have no sound");
  // The media library and FFmpeg's libraries, which name each other through @rpath.
  const frameworks = join(app, "Contents", "Frameworks");
  mkdirSync(frameworks, { recursive: true });
  const libraries = join(ffmpeg, "lib");
  const linked = [...readdirSync(libraries).filter((name) => /^lib(avcodec|avformat|avutil|swresample|swscale)\.\d+\.dylib$/.test(name)), "libzuna_media_ffmpeg.dylib"];
  for (const name of linked) copyFileSync(name.startsWith("libzuna") ? media : join(libraries, name), join(frameworks, name));
  icns(resources);
  // The notification sound, which macOS plays with a notification, from the program's own tones.
  const sound = spawnSync(program, ["--write-notification-sound", join(resources, "notification.wav")], { stdio: "inherit" });
  if (sound.status !== 0) throw new Error("the program couldn't write the notification sound");
  // The words macOS shows when it asks for each permission.
  const info = {
    CFBundleDevelopmentRegion: "en",
    CFBundleDisplayName: name,
    CFBundleExecutable: "zuna",
    CFBundleIconFile: "zuna",
    CFBundleIdentifier: id,
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: name,
    CFBundlePackageType: "APPL",
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    CFBundleURLTypes: [{ CFBundleURLName: "Zuna invite link", CFBundleURLSchemes: ["zuna"] }],
    LSApplicationCategoryType: "public.app-category.social-networking",
    LSMinimumSystemVersion: "14.2",
    NSHighResolutionCapable: true,
    NSSupportsAutomaticGraphicsSwitching: true,
    NSMicrophoneUsageDescription: "Zuna uses the microphone for voice messages and voice channels.",
    NSCameraUsageDescription: "Zuna uses the camera when you turn it on in a voice channel.",
    NSAudioCaptureUsageDescription: "Zuna records your computer's sound only while you share your screen with sound.",
    NSLocationUsageDescription: "Zuna uses your location only when you choose to share it in a chat.",
    NSLocationWhenInUseUsageDescription: "Zuna uses your location only when you choose to share it in a chat.",
  };
  writeFileSync(join(app, "Contents", "Info.plist"), plistFile(info));
  writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");

  const signer = developerId ?? identity("Apple Development");
  if (!signer) console.warn("> no Apple Development identity in the keychain, so this is signed ad hoc: macOS asks again for each permission and the device key after every build");
  // Under the hardened runtime, which notarizing asks for, with the entitlements that let it reach
  // the microphone, the camera and the location. A release's signature is timestamped, as
  // notarizing also asks, and a development build's may be debugged. An ad hoc signature has no
  // team for the runtime to check the libraries the app loads against, so it goes without.
  const options = signer ? ["--options", "runtime", developerId ? "--timestamp" : "--timestamp=none"] : ["--timestamp=none"];
  const debuggable = developerId ? {} : { "com.apple.security.get-task-allow": true };
  const appRights = entitlements("zuna", {
    "com.apple.security.device.audio-input": true,
    "com.apple.security.device.camera": true,
    "com.apple.security.personal-information.location": true,
    ...debuggable,
  });
  // The share's sound program reads the computer's sound as input, from a tap's aggregate device.
  const soundRights = entitlements("zuna-screenshare", { "com.apple.security.device.audio-input": true, ...debuggable });
  const sign = (path, rights) => {
    const signed = spawnSync("codesign", ["--force", "--sign", signer ?? "-", ...options, ...(signer && rights ? ["--entitlements", rights] : []), path], { stdio: ["ignore", "ignore", "inherit"] });
    if (signed.status !== 0) throw new Error(`codesign couldn't sign ${path}`);
  };
  // What's inside first, then the bundle, which seals them.
  for (const name of linked) sign(join(frameworks, name));
  if (existsSync(join(macos, "zuna-screenshare"))) sign(join(macos, "zuna-screenshare"), soundRights);
  sign(app, appRights);
  return app;
}

/** Zips a bundle as `ditto` keeps one, with its links and extended attributes, so that its signature holds. */
function zip(app, out) {
  rmSync(out, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, out]);
}

/** Sends a zip or a DMG to Apple's notary service and waits for its answer, with Apple's log if it's refused. */
function notarize(file) {
  console.log(`> notarizing ${file}, which takes a few minutes`);
  const sent = spawnSync("xcrun", ["notarytool", "submit", file, "--keychain-profile", notaryProfile, "--wait", "--output-format", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  let answer = {};
  try {
    answer = JSON.parse((sent.stdout ?? "").trim().split("\n").at(-1));
  } catch {}
  if (answer.status === "Accepted") return;
  if (answer.id) spawnSync("xcrun", ["notarytool", "log", answer.id, "--keychain-profile", notaryProfile], { stdio: "inherit" });
  else console.error(`Notarizing takes the credentials saved in the keychain as "${notaryProfile}". Save them once with:\n\n  xcrun notarytool store-credentials ${notaryProfile}\n`);
  console.error(`Apple's notary service didn't accept ${file}${answer.status ? `: ${answer.status}` : ""}.`);
  process.exit(1);
}

/**
 * Notarizes the release and staples Apple's ticket to it, then makes a DMG of it to drag into
 * Applications, signed, notarized and stapled too, and a zip, as an update would be fetched.
 */
function packages(app, dist) {
  run("codesign", ["--verify", "--strict", "--deep", "--verbose=2", app]);
  // The app first, so that the one in the DMG carries its ticket and opens offline too.
  const upload = join(target, "Zuna-notarize.zip");
  zip(app, upload);
  notarize(upload);
  rmSync(upload, { force: true });
  run("xcrun", ["stapler", "staple", app]);
  // The DMG: the app beside a link to Applications.
  const image = join(dist, `Zuna-${version}-arm64.dmg`);
  const staging = join(target, "dmg");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  run("ditto", [app, join(staging, "Zuna.app")]);
  symlinkSync("/Applications", join(staging, "Applications"));
  rmSync(image, { force: true });
  run("hdiutil", ["create", "-volname", "Zuna", "-srcfolder", staging, "-format", "ULFO", image]);
  rmSync(staging, { recursive: true, force: true });
  run("codesign", ["--sign", developerId, "--timestamp", image]);
  notarize(image);
  run("xcrun", ["stapler", "staple", image]);
  const archive = join(dist, `Zuna-${version}-arm64.zip`);
  zip(app, archive);
  // What Gatekeeper decides about each, as it would for a download.
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=2", image]);
  console.log(`> wrote ${image} and ${archive}`);
}

checkMetal();
// The FFmpeg the app's media links to (FFMPEG_DIR in apps/desktop/.cargo/config.toml), built
// from its pinned source the first time.
const ffmpeg = await ensureFfmpeg(join(root, "apps", "screenshare", ".deps"));
bundleCore();

const cargo = ["build", ...(release ? ["--release"] : []), ...(testControl ? ["--features", "test-control"] : [])];
run("cargo", cargo, { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, ZUNA_VERSION: version } });
const program = join(target, release ? "release" : "debug", "zuna");
// The app's media through FFmpeg, as a library of its own (apps/desktop/media-ffmpeg).
run("cargo", ["build", ...(release ? ["--release"] : [])], { cwd: join(crate, "media-ffmpeg"), env: { ...env, CARGO_TARGET_DIR: target } });
const media = join(target, release ? "release" : "debug", "libzuna_media_ffmpeg.dylib");

if (command === "build" || command === "dist") {
  const dist = join(root, "dist", "macos");
  mkdirSync(dist, { recursive: true });
  const app = bundle(program, media, dist, { name: "Zuna", id: "chat.zuna.desktop", developerId });
  console.log(`> wrote ${app}`);
  if (command === "dist") packages(app, dist);
} else if (command === "bundle") {
  const app = bundle(program, media, join(target, release ? "release" : "debug"), { name: "Zuna Dev", id: "chat.zuna.desktop.dev" });
  console.log(`> wrote ${app}`);
} else {
  const app = bundle(program, media, join(target, release ? "release" : "debug"), { name: "Zuna Dev", id: "chat.zuna.desktop.dev" });
  const log = join(target, "zuna-dev.log");
  writeFileSync(log, "");
  const dataDir = process.env.ZUNA_DATA_DIR ?? devNativeAppData;
  const passed = ["ZUNA_DATA_DIR=" + dataDir, ...["RUST_LOG", "ZUNA_TEST_CONTROL", "ZUNA_FAKE_MIC", "ZUNA_CHECK_SERVER"].filter((name) => process.env[name]).map((name) => `${name}=${process.env[name]}`)];
  // Through Launch Services, so that macOS asks about Zuna and not this terminal, and waits
  // for the app to quit, with what it writes followed here.
  const opened = spawn("open", ["-n", "-W", "--stdout", log, "--stderr", log, ...passed.flatMap((pair) => ["--env", pair]), app, ...(appArgs.length ? ["--args", ...appArgs] : [])], { stdio: "inherit" });
  const tail = spawn("tail", ["-f", log], { stdio: "inherit" });
  opened.on("exit", (code) => {
    tail.kill();
    process.exit(code ?? 0);
  });
  process.on("SIGINT", () => {
    spawnSync("osascript", ["-e", 'tell application id "chat.zuna.desktop.dev" to quit']);
  });
}
