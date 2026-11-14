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
//   node scripts/macos-app.mjs release
//                                   that, signed ad hoc, with its DMG's backgrounds beside it, for
//                                   scripts/macos-dist.mjs to sign with the Developer ID, as
//                                   .github/workflows/release.yml does
//   node scripts/macos-app.mjs dist
//                                   that, signed with the keychain's Developer ID, notarized and
//                                   stapled, with a DMG and a zip of it beside it
//   node scripts/macos-app.mjs bundle [--release] [--test-control]
//                                   a development build's bundle, not started, for the checks
//   node scripts/macos-app.mjs probe
//                                   the Telegram engine's box tried from inside (platform/sandbox.rs),
//                                   with TDLib built first
//
// With the app's api_id for Telegram (scripts/tdlib.mjs), TDLib is built, and the engine,
// zuna-telegram, beside the program in the bundle, which signs it as code of its own.
//
// A development build is "Zuna Dev", chat.zuna.desktop.dev, apart from a release's
// permissions, and keeps its data in .dev-data/native-app, so that `npm run dev:clean` starts
// it over with the test server. ZUNA_DATA_DIR
// puts it elsewhere. --test-control builds in the checks' socket (src/test_control.rs).
//
// The private keys stay in the keychain, which signs for codesign, and notarizing takes the
// credentials `xcrun notarytool store-credentials zuna-notary` saved there, by that name only.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { ensureFfmpeg, nativeAppDeps } from "./ffmpeg.mjs";
import { BACKGROUNDS, packageApp, signApp } from "./macos-dist.mjs";
import { labelOf } from "./release.mjs";
import { plist } from "./signing.mjs";
import { ensureTdlib, telegramCredentials } from "./tdlib.mjs";
import { ensureWebrtcSys } from "./webrtc-sys.mjs";
import { appStamp, appVersion as version, bundleCore, devNativeAppData, env, parseAppArgs, root, run } from "./lib.mjs";

const { command, flags, appArgs } = parseAppArgs("darwin", ["run", "build", "release", "dist", "bundle", "probe"]);
const release = command === "build" || command === "release" || command === "dist" || flags.includes("--release");
const testControl = flags.includes("--test-control");

const crate = join(root, "apps", "desktop");
// Outside the checkout, as the other systems' builds keep theirs, and kept between checkouts.
const target = join(homedir(), "Library", "Caches", "zuna-desktop-target");
const notaryProfile = "zuna-notary";
// The version, build number and channel a release build is stamped with, and named by.
const stamp = appStamp();
const label = labelOf({ version, channel: stamp.ZUNA_CHANNEL, build: stamp.ZUNA_BUILD });

// A release people download is signed with the Developer ID, as only that can be notarized.
const developerId = command === "dist" ? identity("Developer ID Application") : null;
if (command === "dist" && !developerId) {
  console.error("There's no Developer ID Application identity in the keychain to sign a release with. Import its certificate with the private key, from a .p12, first.");
  process.exit(1);
}

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

/** The Apple Development identity development builds are signed with, saying so when there's none. */
function developmentIdentity() {
  const found = identity("Apple Development");
  if (!found) console.warn("> no Apple Development identity in the keychain, so this is signed ad hoc: macOS asks again for each permission and the device key after every build");
  return found;
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

/**
 * Wraps the program in an app bundle, with the media library beside it, and signs it with an
 * identity, or ad hoc without one. A release build carries its build number as its bundle's
 * version, and a development build the version alone.
 */
function bundle(program, media, out, { name, id, signer, stamped = false }) {
  const app = join(out, `${name}.app`);
  rmSync(app, { recursive: true, force: true });
  const macos = join(app, "Contents", "MacOS");
  const resources = join(app, "Contents", "Resources");
  mkdirSync(macos, { recursive: true });
  mkdirSync(resources, { recursive: true });
  copyFileSync(program, join(macos, "zuna"));
  chmodSync(join(macos, "zuna"), 0o755);
  // The Telegram engine, which the app finds beside itself, and which only a device that links
  // an account ever starts.
  if (telegram) {
    copyFileSync(join(dirname(program), "zuna-telegram"), join(macos, "zuna-telegram"));
    chmodSync(join(macos, "zuna-telegram"), 0o755);
  }
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
    CFBundleVersion: stamped ? stamp.ZUNA_BUILD : version,
    CFBundleURLTypes: [{ CFBundleURLName: "Zuna invite link", CFBundleURLSchemes: ["zuna"] }],
    LSApplicationCategoryType: "public.app-category.social-networking",
    LSMinimumSystemVersion: "14.2",
    NSHighResolutionCapable: true,
    NSSupportsAutomaticGraphicsSwitching: true,
    NSMicrophoneUsageDescription: "Zuna uses the microphone for voice messages and voice channels.",
    NSCameraUsageDescription: "Zuna uses the camera when you turn it on in a voice channel.",
    NSAudioCaptureUsageDescription: "Zuna records your computer's sound only while you share your screen with sound, and hears a video you watch together so that it's kept out of your microphone.",
    NSLocationUsageDescription: "Zuna uses your location only when you choose to share it in a chat.",
    NSLocationWhenInUseUsageDescription: "Zuna uses your location only when you choose to share it in a chat.",
  };
  writeFileSync(join(app, "Contents", "Info.plist"), plist(info));
  writeFileSync(join(app, "Contents", "PkgInfo"), "APPL????");
  signApp(app, signer, { distribution: false });
  return app;
}

/**
 * The DMG's window: apps/desktop/resources/dmg-background.svg drawn at 1× and 2× in the app's
 * Inter, beside the app, where scripts/macos-dist.mjs takes them from.
 */
function drawBackgrounds(folder) {
  const fonts = join(root, "apps", "desktop", "assets", "fonts");
  const font = { fontFiles: [join(fonts, "Inter-Medium.ttf")], loadSystemFonts: false, defaultFontFamily: "Inter" };
  const svg = readFileSync(join(root, "apps", "desktop", "resources", "dmg-background.svg"));
  for (const [file, width] of [[BACKGROUNDS[0], 660], [BACKGROUNDS[1], 1320]]) {
    writeFileSync(join(folder, file), new Resvg(svg, { fitTo: { mode: "width", value: width }, font }).render().asPng());
  }
}

checkMetal();
// The FFmpeg the app's media links to (FFMPEG_DIR in apps/desktop/.cargo/config.toml), built
// from its pinned source the first time.
const ffmpeg = await ensureFfmpeg(nativeAppDeps);
// LiveKit's webrtc-sys with Zuna's patch, which [patch.crates-io] in apps/desktop/Cargo.toml takes.
await ensureWebrtcSys(nativeAppDeps);
// Telegram, with the app's api_id where it's given (scripts/tdlib.mjs): TDLib built, the engine
// built beside the app, and both values built into the app. Without them there's no Telegram.
const telegram = command === "probe" ? null : telegramCredentials();
if (telegram || command === "probe") await ensureTdlib(nativeAppDeps);
bundleCore();

if (command === "probe") {
  // The engine built with --probe, which tries from inside what its box must refuse, started in
  // its box by the app's own test of it. In a folder of its own, as cargo puts both builds at one path.
  const probes = join(target, "probe");
  run("cargo", ["build", "-p", "zuna-telegram", "--features", "probe"], { cwd: crate, env: { ...env, CARGO_TARGET_DIR: probes } });
  run("cargo", ["test", "-p", "zuna-windows", "--bin", "zuna", "--", "platform::sandbox", "--nocapture"], { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, ZUNA_TELEGRAM_PROBE: join(probes, "debug", "zuna-telegram") } });
  process.exit(0);
}

if (telegram) run("cargo", ["build", ...(release ? ["--release"] : []), "-p", "zuna-telegram"], { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target } });
const cargo = ["build", ...(release ? ["--release"] : []), ...(testControl ? ["--features", "test-control"] : [])];
run("cargo", cargo, { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, ...(command === "run" ? { ZUNA_VERSION: version } : stamp), ...(telegram ?? {}) } });
const program = join(target, release ? "release" : "debug", "zuna");
// The app's media through FFmpeg, as a library of its own (apps/desktop/media-ffmpeg).
run("cargo", ["build", ...(release ? ["--release"] : [])], { cwd: join(crate, "media-ffmpeg"), env: { ...env, CARGO_TARGET_DIR: target } });
const media = join(target, release ? "release" : "debug", "libzuna_media_ffmpeg.dylib");

if (command === "build" || command === "release" || command === "dist") {
  const dist = join(root, "dist", "macos");
  mkdirSync(dist, { recursive: true });
  // A build to copy into Applications by hand is signed with the Apple Development identity. A
  // release is signed ad hoc here, and with the Developer ID after.
  const app = bundle(program, media, dist, { name: "Zuna", id: "chat.zuna.desktop", signer: command === "build" ? developmentIdentity() : null, stamped: true });
  if (command !== "build") drawBackgrounds(dist);
  console.log(`> wrote ${app}`);
  if (command === "dist") {
    signApp(app, developerId, { distribution: true });
    const hint = `Notarizing takes the credentials saved in the keychain as "${notaryProfile}". Save them once with:\n\n  xcrun notarytool store-credentials ${notaryProfile}\n`;
    try {
      await packageApp(app, { signer: developerId, auth: ["--keychain-profile", notaryProfile], hint, backgrounds: dist, out: dist, label, zip: true });
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  }
} else if (command === "bundle") {
  const app = bundle(program, media, join(target, release ? "release" : "debug"), { name: "Zuna Dev", id: "chat.zuna.desktop.dev", signer: developmentIdentity() });
  console.log(`> wrote ${app}`);
} else {
  const app = bundle(program, media, join(target, release ? "release" : "debug"), { name: "Zuna Dev", id: "chat.zuna.desktop.dev", signer: developmentIdentity() });
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
