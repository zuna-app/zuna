// Builds or runs the native app (apps/desktop) on Linux, where it runs under Wayland. It
// bundles the client core for QuickJS first, as scripts/windows-app.mjs does, then builds
// with whichever Rust is installed.
//
//   node scripts/linux-app.mjs run [--release] [-- app args]   build and start it
//   node scripts/linux-app.mjs build                            a release build in dist/linux, with
//                                                               the screen share's encoder and FFmpeg in lib,
//                                                               and zuna-watch beside it, and zuna-telegram
//                                                               where the app's api_id is given (scripts/tdlib.mjs)
//   node scripts/linux-app.mjs dist                             that, as a .deb, an .rpm, a pacman
//                                                               package, an AppImage and a .tar.gz
//   node scripts/linux-app.mjs probe                            the Telegram engine's box tried from
//                                                               inside (platform/sandbox.rs), with TDLib
//
// Its data is in ~/.local/share/zuna, or ZUNA_DATA_DIR.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureFfmpeg, nativeAppDeps } from "./ffmpeg.mjs";
import { ensureWebrtcSys } from "./webrtc-sys.mjs";
import { ensureTdlib, telegramCredentials } from "./tdlib.mjs";
import { appStamp, appVersion as version, bundleCore, devNativeAppData, env, parseAppArgs, root, run } from "./lib.mjs";
import { labelOf } from "./release.mjs";

const { command, flags, appArgs } = parseAppArgs("linux", ["run", "build", "dist", "probe"]);
const release = command === "build" || command === "dist" || flags.includes("--release");

const crate = join(root, "apps", "desktop");
// Outside the checkout, as the Windows build's is, and kept between checkouts.
const target = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "zuna-desktop-target");

bundleCore();
// The FFmpeg the repository pins, which the app's media links to and the screen share's encoder
// builds against (FFMPEG_DIR in apps/desktop/.cargo/config.toml).
await ensureFfmpeg(nativeAppDeps);
// LiveKit's webrtc-sys with Zuna's patch, which [patch.crates-io] in apps/desktop/Cargo.toml takes.
await ensureWebrtcSys(nativeAppDeps);
// Telegram, with the app's api_id where it's given (scripts/tdlib.mjs): TDLib built, the engine
// built beside the app, and both values built into the app. Without them there's no Telegram.
const telegram = telegramCredentials();
if (telegram || command === "probe") await ensureTdlib(nativeAppDeps);

if (command === "probe") {
  // The engine built with --probe, which tries from inside what its box must refuse, started in
  // its box by the app's own test of it.
  const engine = buildTelegram(false, true);
  run("cargo", ["test", "-p", "zuna-windows", "--bin", "zuna", "--", "platform::sandbox", "--nocapture"], { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, ZUNA_TELEGRAM_PROBE: engine } });
  process.exit(0);
}

const cargo = [command === "run" ? "run" : "build", ...(release ? ["--release"] : []), ...(appArgs.length ? ["--", ...appArgs] : [])];
// A build started here keeps its data in .dev-data, as on Windows and macOS, apart from an installed
// copy's ~/.local/share/zuna, so that `npm run dev:clean` starts it over with the test server.
const appData = command === "run" ? { ZUNA_DATA_DIR: process.env.ZUNA_DATA_DIR ?? devNativeAppData } : {};
// What a build anyone installs says it is, as on Windows: its version, build number and channel.
const stamp = command === "run" ? { ZUNA_VERSION: version } : appStamp();
const released = { version, channel: stamp.ZUNA_CHANNEL, build: stamp.ZUNA_BUILD };
// The window a video watched together plays in (apps/desktop/watch), which the app finds beside
// itself, and which isn't a default member of its workspace, so that `cargo run` stays the app's.
run("cargo", ["build", ...(release ? ["--release"] : []), "-p", "zuna-watch"], { cwd: crate, env: { ...env, CARGO_TARGET_DIR: target, ...stamp } });
if (telegram) buildTelegram(release, false);
run("cargo", cargo, { cwd: crate, env: { ...env, ...appData, CARGO_TARGET_DIR: target, ...stamp, ...telegram } });

if (command === "build" || command === "dist") {
  const dist = join(root, "dist", "linux");
  mkdirSync(dist, { recursive: true });
  copyFileSync(join(target, "release", "zuna"), join(dist, "zuna"));
  copyFileSync(join(target, "release", "zuna-watch"), join(dist, "zuna-watch"));
  rmSync(join(dist, "zuna-telegram"), { force: true });
  if (telegram) copyFileSync(join(target, "release", "zuna-telegram"), join(dist, "zuna-telegram"));
  // The screen share's encoder and FFmpeg's libraries, which the build gathered and the program
  // finds at $ORIGIN/lib.
  rmSync(join(dist, "lib"), { recursive: true, force: true });
  cpSync(join(target, "release", "lib"), join(dist, "lib"), { recursive: true });
  console.log(`> wrote ${join(dist, "zuna")} and zuna-watch${telegram ? " and zuna-telegram" : ""}, with its libraries in ${join(dist, "lib")}`);
  if (command === "dist") await packages(dist);
}

/**
 * The Telegram engine (apps/desktop/telegram), linked whole, C library and all, so that its box
 * lets it read no file of the system's (platform/sandbox.rs), and put where the app looks for it,
 * beside itself. Built for the target by name, so that crt-static reaches the engine and not the
 * build's own scripts and macros. `probe` adds `--probe`, for the box's test.
 */
function buildTelegram(release, probe) {
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
  const profile = release ? "release" : "debug";
  // The probe in a folder of its own, as cargo puts both builds at one path and needn't put the
  // engine back after.
  const into = probe ? join(target, "probe") : target;
  run("cargo", ["build", ...(release ? ["--release"] : []), "-p", "zuna-telegram", "--target", triple, ...(probe ? ["--features", "probe"] : [])], {
    cwd: crate,
    env: { ...env, CARGO_TARGET_DIR: into, RUSTFLAGS: "-C target-feature=+crt-static" },
  });
  const built = join(into, triple, profile, "zuna-telegram");
  if (probe) return built;
  mkdirSync(join(target, profile), { recursive: true });
  copyFileSync(built, join(target, profile, "zuna-telegram"));
  return built;
}

/** The .deb, .rpm and pacman package, the AppImage and the .tar.gz, from the build in `dist`. */
async function packages(dist) {
  const out = join(dist, "packages");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const icons = join(root, "apps", "desktop", "resources", "icons");
  const sizes = readdirSync(icons).filter((name) => /^\d+x\d+\.png$/.test(name));
  const description = "Zuna: private, end-to-end encrypted chat on servers you run.";
  // As the app writes its own from an AppImage or a .tar.gz (platform/linux/desktop_entry.rs).
  const entry = (exec, icon) =>
    [
      "[Desktop Entry]",
      "Name=Zuna",
      `Comment=${description}`,
      `Exec=${exec} %U`,
      `TryExec=${exec}`,
      "Terminal=false",
      "Type=Application",
      `Icon=${icon}`,
      "StartupWMClass=zuna",
      "MimeType=x-scheme-handler/zuna;",
      "Categories=Network;InstantMessaging;",
      "",
    ].join("\n");
  const run = (program, args, options = {}) => {
    const done = spawnSync(program, args, { stdio: "inherit", env, ...options });
    if (done.status !== 0) throw new Error(`${program} ${args.join(" ")} failed`);
  };

  // --- The three packages, through nfpm, laid out as /usr/lib/zuna with a link in /usr/bin ---
  const desktop = join(out, "zuna.desktop");
  writeFileSync(desktop, entry("/usr/bin/zuna", "zuna"));
  run("desktop-file-validate", [desktop]);
  const contents = [
    { src: join(dist, "zuna"), dst: "/usr/lib/zuna/zuna", file_info: { mode: 0o755 } },
    { src: join(dist, "zuna-watch"), dst: "/usr/lib/zuna/zuna-watch", file_info: { mode: 0o755 } },
    ...(existsSync(join(dist, "zuna-telegram")) ? [{ src: join(dist, "zuna-telegram"), dst: "/usr/lib/zuna/zuna-telegram", file_info: { mode: 0o755 } }] : []),
    { src: join(dist, "lib"), dst: "/usr/lib/zuna/lib", type: "tree" },
    { src: "/usr/lib/zuna/zuna", dst: "/usr/bin/zuna", type: "symlink" },
    { src: desktop, dst: "/usr/share/applications/zuna.desktop", file_info: { mode: 0o644 } },
    { src: join(root, "LICENSE"), dst: "/usr/share/licenses/zuna/LICENSE", file_info: { mode: 0o644 } },
    ...sizes.map((name) => ({ src: join(icons, name), dst: `/usr/share/icons/hicolor/${name.replace(".png", "")}/apps/zuna.png`, file_info: { mode: 0o644 } })),
  ];
  // What the program links and loads, by each system's names: Wayland, Vulkan, fonts, PipeWire,
  // the portals, and WebKitGTK 6.0 with GStreamer's good plugins, which zuna-watch plays a video
  // watched together through, so that it plays wherever the app is installed from a package.
  // Recommended: a color emoji font, GeoClue for location, and libav's decoders. The AppImage and
  // the .tar.gz take what the system has, and the app says what to install when it's missing.
  const config = {
    name: "zuna",
    arch: "amd64",
    platform: "linux",
    version,
    // A nightly sorts before the release it leads to, and after the nightlies before it.
    ...(released.channel === "nightly" ? { prerelease: `nightly.${released.build}` } : {}),
    release: "1",
    maintainer: "Zuna contributors <zuna@users.noreply.github.com>",
    description,
    homepage: "https://zuna.chat",
    license: "AGPL-3.0-only",
    section: "net",
    contents,
    overrides: {
      deb: {
        depends: ["libc6", "libxkbcommon0", "libwayland-client0", "libvulkan1", "libfontconfig1", "libfreetype6", "libpipewire-0.3-0t64 | libpipewire-0.3-0", "xdg-desktop-portal", "libwebkitgtk-6.0-4", "gstreamer1.0-plugins-good"],
        recommends: ["mesa-vulkan-drivers", "fonts-noto-color-emoji", "geoclue-2.0", "gstreamer1.0-libav"],
      },
      rpm: {
        // The good plugins are named one way on Fedora and another on openSUSE, either of which will do.
        depends: [
          "libxkbcommon.so.0()(64bit)",
          "libwayland-client.so.0()(64bit)",
          "libvulkan.so.1()(64bit)",
          "libfontconfig.so.1()(64bit)",
          "libfreetype.so.6()(64bit)",
          "libpipewire-0.3.so.0()(64bit)",
          "xdg-desktop-portal",
          "libwebkitgtk-6.0.so.4()(64bit)",
          "(gstreamer1-plugins-good or gstreamer-plugins-good)",
        ],
        recommends: ["mesa-vulkan-drivers", "geoclue2"],
      },
      // nfpm writes no optdepends for pacman, so Arch gets only what the program needs.
      archlinux: {
        depends: ["libxkbcommon", "wayland", "vulkan-icd-loader", "fontconfig", "freetype2", "pipewire", "xdg-desktop-portal", "webkitgtk-6.0", "gst-plugins-good"],
      },
    },
  };
  // nfpm reads YAML, of which JSON is a part.
  const settings = join(out, "nfpm.json");
  writeFileSync(settings, JSON.stringify(config, null, 2));
  // Named by this script, as each packager's own name for a nightly has a character a release's
  // file can't keep.
  const label = labelOf(released);
  for (const [packager, name] of [["deb", `Zuna-${label}-amd64.deb`], ["rpm", `Zuna-${label}-x86_64.rpm`], ["archlinux", `Zuna-${label}-x86_64.pkg.tar.zst`]]) {
    run("go", ["run", "github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.47.0", "package", "--config", settings, "--packager", packager, "--target", join(out, name)]);
  }
  rmSync(settings);
  rmSync(desktop);

  // --- The AppImage: the runtime, pinned by its hash, with the program's folder appended as SquashFS ---
  const runtime = join(root, "apps", "desktop", ".deps", "runtime-x86_64");
  const runtimeHash = "2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d";
  const hash = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (!existsSync(runtime) || hash(runtime) !== runtimeHash) {
    mkdirSync(join(root, "apps", "desktop", ".deps"), { recursive: true });
    // Tried a few times: a release's run lost its connection here once, with everything else built.
    let bytes;
    for (let attempt = 1; !bytes; attempt++) {
      try {
        const response = await fetch("https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64");
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (attempt === 4) throw new Error(`The AppImage runtime couldn't be fetched: ${error.cause?.message ?? error.message}`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      }
    }
    writeFileSync(runtime, bytes);
    if (hash(runtime) !== runtimeHash) throw new Error("The AppImage runtime isn't the one pinned.");
  }
  const appDir = join(dist, "Zuna.AppDir");
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(join(appDir, "usr", "lib", "zuna"), { recursive: true });
  copyFileSync(join(dist, "zuna"), join(appDir, "usr", "lib", "zuna", "zuna"));
  copyFileSync(join(dist, "zuna-watch"), join(appDir, "usr", "lib", "zuna", "zuna-watch"));
  if (existsSync(join(dist, "zuna-telegram"))) copyFileSync(join(dist, "zuna-telegram"), join(appDir, "usr", "lib", "zuna", "zuna-telegram"));
  cpSync(join(dist, "lib"), join(appDir, "usr", "lib", "zuna", "lib"), { recursive: true });
  symlinkSync("usr/lib/zuna/zuna", join(appDir, "AppRun"));
  // The runtime's own .desktop file and icon, for tools that look; the app writes its own as it starts.
  writeFileSync(join(appDir, "zuna.desktop"), entry("zuna", "zuna"));
  copyFileSync(join(icons, "256x256.png"), join(appDir, "zuna.png"));
  symlinkSync("zuna.png", join(appDir, ".DirIcon"));
  const squashfs = join(dist, "Zuna.squashfs");
  run("mksquashfs", [appDir, squashfs, "-root-owned", "-noappend", "-comp", "zstd", "-quiet"]);
  const image = join(out, `Zuna-${label}-x86_64.AppImage`);
  writeFileSync(image, Buffer.concat([readFileSync(runtime), readFileSync(squashfs)]));
  chmodSync(image, 0o755);
  rmSync(squashfs);
  rmSync(appDir, { recursive: true, force: true });

  // --- The .tar.gz: the program and its libraries in one folder ---
  const folder = `zuna-${version}`;
  const staged = join(dist, folder);
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(staged);
  copyFileSync(join(dist, "zuna"), join(staged, "zuna"));
  copyFileSync(join(dist, "zuna-watch"), join(staged, "zuna-watch"));
  if (existsSync(join(dist, "zuna-telegram"))) copyFileSync(join(dist, "zuna-telegram"), join(staged, "zuna-telegram"));
  cpSync(join(dist, "lib"), join(staged, "lib"), { recursive: true });
  run("tar", ["-czf", join(out, `Zuna-${label}-x86_64.tar.gz`), "-C", dist, folder]);
  rmSync(staged, { recursive: true, force: true });
  console.log(`> wrote ${readdirSync(out).join(", ")} in ${out}`);
}
