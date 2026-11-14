// Drives the native app on Linux in a KWin of its own, against a real server and a real
// client in Node as the other person, checks what it does, and saves screenshots to look
// over. Nothing it starts reaches the person's own desktop: it has its own session bus,
// KWin, folders and data, and KWin only gives the driver (test/driver) its fake input and
// window management because the .desktop file this writes names them.
//
//   node apps/desktop/test/linux-check.mjs [screenshot-dir]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { viteNodeArgs } from "../../../scripts/lib.mjs";
import { appBinary, here, inside, outside, root, sleep, until } from "./linux-session.mjs";

await outside(import.meta.url);
const { work, base, session, shots, check, start, shot, kwinFrames, clipboard, idleCost, quietSpeakers, loudestOn, startServer, startKeyring, startDriver, finish } = await inside({ shots: process.argv[2] });

let peer;
try {
  const { port, setupLink, server } = await startServer();
  check("the check's own keyring holds the Secret Service's name", await startKeyring());

  // Without Wayland it says so and leaves, rather than running with no window.
  const noWayland = spawnSync(appBinary, [], { env: { ...base, ZUNA_DATA_DIR: join(work, "no-wayland") }, encoding: "utf8", timeout: 20_000 });
  check("without Wayland it says so and exits", noWayland.status === 1 && noWayland.stderr.includes("needs Wayland"), `status ${noWayland.status}`);

  // The core without a window, as a development build checks it.
  const coreData = join(work, "core-only");
  const coreCheck = spawnSync(appBinary, ["--core-check", "listServers"], { env: { ...base, ZUNA_DATA_DIR: coreData }, encoding: "utf8", timeout: 60_000 });
  check("--core-check runs the core without a window", coreCheck.status === 0 && coreCheck.stdout.trim() === "[]", coreCheck.stdout.trim() || coreCheck.stderr.trim().split("\n").pop());

  const { drive, windowOf, events, heardEvent } = await startDriver();
  const appData = join(work, "app");
  // A 12-hour clock, from the locale as a desktop sets it.
  // Its sounds go to speakers nobody hears, in place of the system's default.
  const speakers = quietSpeakers("speakers");
  const app = start(appBinary, [], { ...session, ZUNA_DATA_DIR: appData, LC_TIME: "en_US.UTF-8", RUST_LOG: "warn,zuna::platform=info", ZUNA_CHECK_SPEAKERS: speakers }, "app");

  // --- The window ---
  const first = await until(windowOf, "the app's window", 30_000);
  check("the window's app ID is its .desktop file's", first.appId === "zuna");
  check("the window is named", first.title === "Zuna", first.title);
  const registered = await heardEvent((event) => event.trayRegistered);
  check("the tray's icon registers", !!registered);
  const tray = registered ? await drive({ do: "tray" }) : {};
  check("it's the app's, with its name as the tooltip and its icon in several sizes", tray.id === "zuna" && tray.tooltip === "Zuna" && tray.icons?.length >= 3, JSON.stringify(tray));
  check("the desktop's animations being off reaches the app", await until(() => app.output.includes("animations are off"), "the setting", 10_000).catch(() => false));
  await sleep(1500);
  await shot("01-start");
  // Who draws the window's frame, as the app says each time the compositor decides.
  const frames = () => app.output.match(/(?<=the )(app|compositor)(?= draws the window's frame)/g) ?? [];
  check("where the compositor draws no frames, as GNOME's doesn't, the app draws its own", frames().at(-1) === "app", frames().join(", "));

  // The app's own title bar, as Windows gives it: buttons, dragging, a double click, and resizing.
  const bar = (window, x) => ({ x: window.x + x, y: window.y + 16 });
  const button = (window, fromRight) => ({ x: window.x + window.width - fromRight, y: window.y + 16 });
  let window = await windowOf();
  await drive({ do: "click", ...button(window, 69) });
  window = await until(async () => ((await windowOf())?.maximized ? windowOf() : null), "maximizing", 5_000).catch(() => windowOf());
  check("the maximize button maximizes", window.maximized);
  await drive({ do: "click", ...button(window, 69) });
  window = await until(async () => ((await windowOf())?.maximized === false ? windowOf() : null), "restoring", 5_000).catch(() => windowOf());
  check("pressing it again restores", !window.maximized);
  await drive({ do: "click", ...bar(window, 300), count: 2 });
  await sleep(600);
  check("a double click on the title bar maximizes", (await windowOf()).maximized);
  window = await windowOf();
  await drive({ do: "click", ...bar(window, 300), count: 2 });
  await sleep(600);
  window = await windowOf();
  check("and another restores", !window.maximized);
  const from = bar(window, 300);
  await drive({ do: "drag", from: [from.x, from.y], to: [from.x - 40, from.y + 30], steps: 12 });
  await sleep(600);
  const moved = await windowOf();
  check("dragging the title bar moves the window", Math.abs(moved.x - window.x + 40) <= 3 && Math.abs(moved.y - window.y - 30) <= 3, `by ${moved.x - window.x},${moved.y - window.y}`);
  const right = { x: moved.x + moved.width + 3, y: moved.y + Math.round(moved.height / 2) };
  await drive({ do: "drag", from: [right.x, right.y], to: [right.x - 80, right.y], steps: 10 });
  await sleep(600);
  const narrower = await windowOf();
  check("dragging the right edge resizes", Math.abs(narrower.width - (moved.width - 80)) <= 3, `${moved.width} to ${narrower.width}`);
  const top = { x: narrower.x + Math.round(narrower.width / 2), y: narrower.y - 3 };
  await drive({ do: "drag", from: [top.x, top.y], to: [top.x, top.y - 20], steps: 10 });
  await sleep(600);
  const taller = await windowOf();
  check("dragging the top edge resizes", Math.abs(taller.height - (narrower.height + 20)) <= 3 && Math.abs(taller.y - (narrower.y - 20)) <= 3, `${narrower.height} to ${taller.height}`);
  await drive({ do: "click", ...button(taller, 115) });
  await sleep(600);
  check("the minimize button minimizes", (await windowOf()).minimized);
  await drive({ do: "restore", appId: "zuna" });
  await sleep(600);
  check("and the taskbar brings it back", !(await windowOf()).minimized);
  await drive({ do: "click", ...button(await windowOf(), 23) });
  await sleep(600);
  const closed = await windowOf();
  check("closing keeps it running, minimized, as it's on to the tray", !!closed && closed.minimized && app.exitCode === null);
  // The stand-in host's token isn't one KWin made, so KWin only marks the window as wanting
  // attention; with KDE's own tray it comes back (checked by hand).
  const clicked = await drive({ do: "tray-activate" });
  await sleep(800);
  check("a click on the tray's icon shows the window with the token it was handed", app.output.includes("showing the window with an activation token"), JSON.stringify(clicked));
  await drive({ do: "restore", appId: "zuna" });
  await sleep(600);
  // Maximized from here on, so where things are is the same each run.
  await drive({ do: "click", ...bar(await windowOf(), 300), count: 2 });
  await sleep(800);
  check("maximized for the rest", (await windowOf()).maximized);

  // --- Onboarding, as the server's owner ---
  await drive({ do: "click", x: 700, y: 535 });
  await sleep(600);
  await shot("02-invite");
  await drive({ do: "type", text: setupLink });
  await drive({ do: "key", key: "enter" });
  await sleep(2000);
  await shot("03-owner");
  const password = `linux-check-${process.pid}-owner`;
  await drive({ do: "click", x: 700, y: 312 });
  await drive({ do: "type", text: "Linux Owner" });
  await drive({ do: "click", x: 700, y: 389 });
  await drive({ do: "press", keys: ["ctrl", "a"] });
  await drive({ do: "type", text: "owner" });
  await drive({ do: "click", x: 680, y: 488 });
  await drive({ do: "type", text: password });
  await drive({ do: "click", x: 680, y: 586 });
  await drive({ do: "type", text: password });
  await sleep(300);
  await shot("04-owner-filled");
  await drive({ do: "click", x: 700, y: 732 });
  // The recovery key, copied to Wayland's clipboard once the account is made.
  const recovery = await until(async () => {
    await drive({ do: "click", x: 607, y: 538 });
    await sleep(500);
    return /^([A-Z0-9]{4}-){9}[A-Z0-9]{4}$/.test(clipboard().trim()) ? clipboard().trim() : null;
  }, "the recovery key to be copied", 60_000).catch(() => null);
  check("the account is made, and Copy puts its recovery key on the clipboard", !!recovery);
  const sealed = existsSync(join(appData, "device-key.sealed")) ? readFileSync(join(appData, "device-key.sealed"), "utf8") : "";
  const stored = spawnSync("secret-tool", ["search", "--all", "application", "chat.zuna"], { env: session, encoding: "utf8", timeout: 10_000 });
  check("the device key is in the Secret Service, with only its item's ID on disk", sealed.startsWith("secret-service:") && `${stored.stdout}${stored.stderr}`.includes("device-key") && !existsSync(join(appData, "device-key.bin")), `${sealed.slice(0, 20)}, plain ${existsSync(join(appData, "device-key.bin"))}, ${stored.stdout.split("\n").length} lines found`);
  await shot("05-recovery-key");
  await drive({ do: "click", x: 529, y: 582 });
  await drive({ do: "click", x: 700, y: 630 });
  await sleep(800);
  await shot("06-name-server");
  await drive({ do: "click", x: 700, y: 491 });
  await drive({ do: "type", text: "Linux Lab" });
  await drive({ do: "click", x: 700, y: 546 });
  await sleep(2500);
  await shot("07-ready");

  // --- An invite, and the other person through it ---
  await drive({ do: "click", x: 123, y: 57 });
  await sleep(500);
  await drive({ do: "click", x: 151, y: 98 });
  await sleep(700);
  // Another app's copy since the last key here: KWin drops a selection older than the one it
  // holds, so a copy made with a click has to carry the click's serial.
  spawn("wl-copy", ["Copied in another app"], { env: session, stdio: "ignore" });
  await until(() => clipboard() === "Copied in another app", "the other app's copy", 5_000).catch(() => null);
  await drive({ do: "click", x: 700, y: 540 });
  const invite = await until(() => (/\/invite\/\S+#k=/.test(clipboard()) ? clipboard().trim() : null), "the invite link to be copied", 15_000).catch(() => null);
  check("Create invite link copies a link with its key, with a click after another app copied something", !!invite);
  await shot("08-invite-made");
  // Its ×, as Escape only reaches a dialog through a field in it.
  await drive({ do: "click", x: 889, y: 281 });
  peer = start(...viteNodeArgs(join(here, "peer.ts"), invite ?? ""), { ...process.env, MANGOHUD: "0", DISABLE_MANGOHUD: "1" }, "peer", join(root, "packages", "core"));
  peer.stdout.removeAllListeners("data");
  const heard = [];
  createInterface({ input: peer.stdout }).on("line", (line) => {
    peer.output += `${line}\n`;
    try {
      heard.push(JSON.parse(line));
    } catch {}
  });
  await until(() => heard.some((line) => line.ready), "the other person to join", 90_000);
  peer.stdin.write(`${JSON.stringify({ send: "Hi from Casey" })}\n`);
  await sleep(3000);
  await shot("09-list");

  // --- Chatting ---
  await drive({ do: "click", x: 237, y: 251 });
  await sleep(1000);
  const message = "Hello from Linux, under Wayland!";
  await drive({ do: "type", text: message });
  await drive({ do: "key", key: "enter" });
  const received = await until(() => heard.find((line) => line.received === message), "the message to reach the other person", 20_000).catch(() => null);
  check("a message typed and sent reaches the other person", !!received);
  await sleep(2500);
  await shot("10-chat");

  // --- A file copied in a file manager, pasted into the message box ---
  const copied = join(work, "copied-notes.txt");
  writeFileSync(copied, "Copied in a file manager.\n");
  const copying = spawn("wl-copy", ["--type", "text/uri-list"], { env: session, stdio: ["pipe", "ignore", "ignore"] });
  copying.stdin.end(`file://${copied}\r\n`);
  await sleep(800);
  await drive({ do: "click", x: 860, y: 875 });
  await drive({ do: "press", keys: ["ctrl", "v"] });
  await sleep(800);
  await shot("10b-pasted-file");
  const before = heard.length;
  await drive({ do: "key", key: "enter" });
  check("a file copied in a file manager pastes into the message box and goes", !!(await until(() => heard.length > before, "the file to arrive", 20_000).catch(() => null)));
  await sleep(1500);

  // --- A voice message the desktop recorded, from the other person, played here ---
  const fixtures = join(root, "apps", "ios", "ZunaKit", "Tests", "ZunaHostTests", "Fixtures");
  peer.stdin.write(`${JSON.stringify({ sendFile: { path: join(fixtures, "chromium-opus.m4a"), name: "Voice message.m4a", mime: "audio/mp4", duration: 3.4, voice: true } })}\n`);
  await until(() => heard.some((line) => line.sentFile), "the voice message to go", 20_000);
  await sleep(2500);
  await shot("10c-voice-arrived");
  const listening = loudestOn(speakers, 8);
  await sleep(300);
  // Its play button, under the other person's echo of what the app sent last, pointed at
  // first, as a hand would: the message list only takes a click where the pointer has been.
  await drive({ do: "move", x: 430, y: 752 });
  await sleep(400);
  await drive({ do: "click", x: 430, y: 752 });
  await sleep(2000);
  await shot("10d-voice-playing");
  const played = await listening;
  check("a voice message the desktop recorded plays here, through PipeWire", played > 0.05, `peak ${played.toFixed(3)}`);

  // --- The ticks of your own last message in the list: one when sent, two once read ---
  peer.stdin.write(`${JSON.stringify({ quiet: true })}\n`);
  await drive({ do: "click", x: 860, y: 875 });
  const unanswered = "This one waits to be read";
  await drive({ do: "type", text: unanswered });
  await drive({ do: "key", key: "enter" });
  check("a message the other person doesn't answer reaches them", !!(await until(() => heard.find((line) => line.received === unanswered), "the message", 15_000).catch(() => null)));
  await sleep(1500);
  await shot("10e-list-sent");
  peer.stdin.write(`${JSON.stringify({ read: true })}\n`);
  check("the other person reads the chat", !!(await until(() => heard.find((line) => line.read), "the reading", 15_000).catch(() => null)));
  await sleep(1500);
  await shot("10f-list-read");
  peer.stdin.write(`${JSON.stringify({ quiet: false })}\n`);

  // --- A picture, opened as Telegram's are: in a window of its own over the whole screen ---
  // Found by its color, wherever the chat lays it out.
  const green = [46, 160, 67];
  const landscape = join(work, "landscape.png");
  writeFileSync(landscape, png(1600, 900, Buffer.alloc(1600 * 900 * 4).fill(Buffer.from([...green, 255]))));
  peer.stdin.write(`${JSON.stringify({ sendFile: { path: landscape, name: "landscape.png", mime: "image/png", width: 1600, height: 900 } })}\n`);
  await until(() => heard.some((line) => line.sentFile === "landscape.png"), "the picture to go", 20_000);
  await sleep(3000);
  const tile = readPng(await shot("10g-picture-arrived")).box((color) => near(color, green, 8));
  check("a picture from the other person shows in the chat", !!tile && tile.width > 150, JSON.stringify(tile));
  const viewers = async () => (await drive({ do: "windows" })).windows.filter((window) => window.appId === "zuna" && window.fullscreen);
  const openTile = async () => {
    await drive({ do: "move", ...tile.middle });
    await sleep(300);
    await drive({ do: "click", ...tile.middle });
    return until(async () => (await viewers())[0], "the viewer's window", 5_000).catch(() => null);
  };
  const viewer = tile ? await openTile() : null;
  check("clicking it opens it in a window of its own, over the whole screen, in front", viewer?.x === 0 && viewer.y === 0 && viewer.width === 1400 && viewer.height === 900 && viewer.active, JSON.stringify(viewer));
  check("which is named only Zuna, not after the picture", viewer?.title === "Zuna", viewer?.title);
  await sleep(600);
  // Fitted to the screen less 40 px around, 1320 by 742, in the middle, on a dark shade.
  const viewed = readPng(await shot("10h-picture-viewer"));
  const fitted = viewed.box((color) => near(color, green, 8));
  const shade = [viewed.at(12, 12), viewed.at(1388, 450), viewed.at(700, 885)];
  check("the picture is fitted to the screen, in its middle", !!fitted && Math.abs(fitted.width - 1320) <= 3 && Math.abs(fitted.height - 742) <= 3 && Math.abs(fitted.middle.x - 700) <= 2 && Math.abs(fitted.middle.y - 450) <= 2, JSON.stringify(fitted));
  check("on a dark shade over what's behind", shade.every((color) => Math.max(...color) < 40), JSON.stringify(shade));
  // A message coming in while it's open is notified, and leaves it in front: asking for the
  // chat's window then brought it over the viewer, as KWin lets an app in front do.
  const whileViewing = events.length;
  peer.stdin.write(`${JSON.stringify({ send: "While the picture is open" })}\n`);
  const noticed = await heardEvent((event) => event.notified, 15_000, whileViewing);
  await sleep(1500);
  const after = (await drive({ do: "windows" })).windows.filter((window) => window.appId === "zuna");
  const stillViewing = after.find((window) => window.fullscreen);
  check("a message coming in while it's open is notified, and leaves it in front of the chat's window", !!noticed && !!stillViewing?.active && !after.some((window) => !window.fullscreen && window.active), JSON.stringify({ notified: !!noticed, windows: after.map(({ fullscreen, active }) => ({ fullscreen, active })) }));
  await shot("10i-message-over-viewer");
  await drive({ do: "key", key: "escape" });
  check("Escape closes it", !!(await until(async () => ((await viewers()).length === 0 ? true : null), "the viewer to close", 5_000).catch(() => null)));
  check("leaving the chat's window, in front again", !!(await until(async () => ((await windowOf())?.active ? true : null), "the chat's window to be in front", 5_000).catch(() => null)));
  // Where the message that came is read, and its badge goes, before the next chat's.
  await heardEvent((event) => event.badge?.count === 0, 10_000, whileViewing);
  if (tile && (await openTile())) {
    await drive({ do: "click", x: 20, y: 450 });
    check("a click on the shade closes it too", !!(await until(async () => ((await viewers()).length === 0 ? true : null), "the viewer to close", 5_000).catch(() => null)));
  } else check("it opens again", false);
  await sleep(500);

  // --- Notifications and the badge, with another chat open ---
  await drive({ do: "click", x: 237, y: 311 });
  await sleep(800);
  let since = events.length;
  const unsafe = "<b>Bold</b> & <a href='https://example.com'>a link</a>";
  const sound = loudestOn(speakers, 8);
  await sleep(500);
  peer.stdin.write(`${JSON.stringify({ send: unsafe })}\n`);
  const notified = (await heardEvent((event) => event.notified, 15_000, since))?.notified;
  check("a message in another chat shows a system notification, named and pictured", notified?.summary === "Casey Park" && notified?.image && notified?.desktopEntry === "zuna" && notified?.actions?.includes("default"), JSON.stringify({ ...notified, image: notified?.image && `${notified.image.width}×${notified.image.height}` }));
  check("its text goes as text, not markup", notified?.body === "&lt;b&gt;Bold&lt;/b&gt; &amp; &lt;a href='https://example.com'&gt;a link&lt;/a&gt;", notified?.body);
  check("the server adds no sound, as the app plays its own", notified?.suppressSound === true);
  // As beside the chat in the list: Casey has no photo, so their initials on their color.
  const initials = picture(notified, "11-notification-initials");
  const whites = initials ? initials.count((x, y, [r, g, b, a]) => y > 40 && y < 88 && a === 255 && Math.min(r, g, b) > 220) : 0;
  check(
    "its picture is round, with the initials on the chat's color",
    initials?.width === 128 && initials.height === 128 && initials.channels === 4 && initials.at(0, 0)[3] === 0 && near(initials.at(64, 8), [...avatarColor(heard.find((line) => line.ready).userId), 255]) && whites > 100,
    initials && `${initials.width}×${initials.height}, corner ${initials.at(0, 0)}, top ${initials.at(64, 8)}, ${whites} white`,
  );
  const chime = await sound;
  check("and the app's own plays, through PipeWire", chime > 0.02, `peak ${chime.toFixed(3)}`);
  const badge = await heardEvent((event) => event.badge?.count === 1, 10_000, since);
  check("the badge shows one unread", !!badge && badge.badge.visible === true && badge.badge.app === "application://zuna.desktop", JSON.stringify(badge));
  const tooltip = await drive({ do: "tray" });
  check("and so does the tray's tooltip", tooltip.tooltip === "Zuna: 1 unread", tooltip.tooltip);
  await shot("11-notified");
  since = events.length;
  await drive({ do: "invoke", id: notified?.id ?? 0 });
  await sleep(1200);
  await shot("12-from-notification");
  const opened = "Opened from a notification";
  await drive({ do: "type", text: opened });
  await drive({ do: "key", key: "enter" });
  check("clicking it opens its chat", !!(await until(() => heard.find((line) => line.received === opened), "the message", 15_000).catch(() => null)));
  check("and reading it clears the badge", !!(await heardEvent((event) => event.badge?.count === 0, 10_000, since)));
  // Taken back once the chat is read in the app, and with Casey's photo once they have one.
  const photo = join(work, "casey.png");
  writeFileSync(photo, png(256, 256, Buffer.alloc(256 * 256 * 4).fill(Buffer.from([208, 96, 42, 255]))));
  peer.stdin.write(`${JSON.stringify({ avatar: photo })}\n`);
  await until(() => heard.some((line) => line.avatarSet), "the photo to be set", 20_000);
  await drive({ do: "click", x: 237, y: 311 });
  await sleep(3000);
  since = events.length;
  peer.stdin.write(`${JSON.stringify({ send: "Another one" })}\n`);
  const second = (await heardEvent((event) => event.notified, 15_000, since))?.notified;
  const withPhoto = picture(second, "11-notification-photo");
  check("with a photo, its picture is the photo, round", withPhoto?.at(0, 0)[3] === 0 && near(withPhoto.at(64, 64), [208, 96, 42, 255]) && near(withPhoto.at(64, 2), [208, 96, 42, 255]), withPhoto && `corner ${withPhoto.at(0, 0)}, middle ${withPhoto.at(64, 64)}, top ${withPhoto.at(64, 2)}`);
  await drive({ do: "click", x: 237, y: 251 });
  check("a notification is taken back when its chat is read", !!second && !!(await heardEvent((event) => event.closed === second.id, 10_000, since)));

  // --- One app at a time ---
  await drive({ do: "click", x: 237, y: 311 });
  const link = `zuna://127.0.0.1:${port}/invite/second-start`;
  const secondStart = spawnSync(appBinary, [link], { env: { ...session, ZUNA_DATA_DIR: appData, XDG_ACTIVATION_TOKEN: "second-start-token" }, encoding: "utf8", timeout: 20_000 });
  await sleep(1500);
  check("a second start hands its link over and leaves", secondStart.status === 0 && app.exitCode === null, `status ${secondStart.status}`);
  await shot("13-second-start");
  // Its dialog, closed from the backdrop.
  await drive({ do: "click", x: 1350, y: 860 });

  // --- What the window costs at rest ---
  await drive({ do: "move", x: 900, y: 300 });
  await sleep(2000);
  const rest = await idleCost(app.pid, 5);
  // Not at the display's refresh rate, as GPUI 0.2.2's Wayland window woke it. Zed's v1.27.0 parks
  // its frame loop while nothing wants a frame.
  check("at rest it hardly wakes", rest.wakeups < 20, `${rest.wakeups} main-thread wakeups a second, ${rest.cpu.toFixed(1)}% of a core, with KWin at 60 Hz`);

  // --- Away, from the compositor, after 30 s without input, as Telegram counts it ---
  await until(() => app.output.includes("the person is away"), "the person to be away", 45_000).catch(() => null);
  check("30 s without input counts as away", app.output.includes("the person is away"));
  await drive({ do: "move", x: 700, y: 400 });
  await drive({ do: "move", x: 720, y: 420 });
  check("and input as back", !!(await until(() => app.output.includes("the person is back"), "the person to be back", 5_000).catch(() => null)));

  // --- The compositor's frame ---
  // Asked for through xdg-decoration, it takes the place of the app's own title bar as soon as
  // KWin can draw one, and the connection, which that title bar showed, shows atop the
  // conversation list, as on the web. The server stops for it, last of all.
  kwinFrames(true);
  check("once KWin draws frames, the app leaves the frame to it", !!(await until(() => frames().at(-1) === "compositor", "KWin's frame", 10_000).catch(() => null)), frames().join(", "));
  const framed = await until(async () => {
    const window = await windowOf();
    return window.client.y > window.y ? window : null;
  }, "KWin's title bar", 5_000).catch(() => windowOf());
  check("with KWin's title bar above the window", framed.client.y - framed.y >= 20, `${framed.client.y - framed.y} px`);
  server.kill();
  await sleep(3000);
  await shot("14-kwin-frame-offline");

  // --- Quitting from the tray, and the key read back from the Secret Service ---
  await drive({ do: "tray-menu", label: "Quit" });
  check("Quit in the tray's menu quits", !!(await until(() => app.exitCode !== null, "the app to quit", 10_000).catch(() => null)));
  const again = spawnSync(appBinary, ["--core-check", "listServers"], { env: { ...session, ZUNA_DATA_DIR: appData }, encoding: "utf8", timeout: 60_000 });
  check("starting again reads the device key back from the Secret Service", again.status === 0 && again.stdout.includes("Linux Lab"), again.stderr.trim().split("\n").pop());
  await finish();
} catch (error) {
  await finish(error);
}

/** A notification's picture, saved beside the screenshots. */
function picture(notified, name) {
  const image = notified?.image;
  if (!image?.hex) return null;
  const rgba = Buffer.from(image.hex, "hex");
  writeFileSync(join(shots, `${name}.png`), png(image.width, image.height, rgba));
  const at = (x, y) => [...rgba.subarray(y * image.stride + x * 4, y * image.stride + x * 4 + 4)];
  const count = (test) => {
    let found = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (test(x, y, at(x, y))) found++;
    return found;
  };
  return { ...image, at, count };
}

function near(color, expected, by = 3) {
  return color.length === expected.length && color.every((value, index) => Math.abs(value - expected[index]) <= by);
}

/** The color `format::avatar_color` gives someone without a photo. */
function avatarColor(seed) {
  const colors = ["#5b6b7a", "#6e625c", "#5f7065", "#7a6c58", "#6b6470", "#557072", "#7a6060", "#5f6775"];
  let hash = 0;
  for (let index = 0; index < seed.length; index++) hash = (Math.imul(hash, 31) + seed.charCodeAt(index)) | 0;
  const hex = colors[Math.abs(hash) % colors.length];
  return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
}

/** A screenshot's pixels, as Spectacle saves them: 8 bits a channel, RGB or RGBA. `box` is
 * where the pixels that pass a test lie, and its middle. */
function readPng(file) {
  const data = readFileSync(file);
  let width = 0;
  let height = 0;
  let channels = 4;
  const compressed = [];
  for (let at = 8; at < data.length; ) {
    const length = data.readUInt32BE(at);
    const type = data.toString("latin1", at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") [width, height, channels] = [body.readUInt32BE(0), body.readUInt32BE(4), body[9] === 2 ? 3 : 4];
    if (type === "IDAT") compressed.push(body);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const corner = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const guess = left + up - corner;
      const paeth = Math.abs(guess - left) <= Math.abs(guess - up) && Math.abs(guess - left) <= Math.abs(guess - corner) ? left : Math.abs(guess - up) <= Math.abs(guess - corner) ? up : corner;
      pixels[y * stride + x] = (raw[y * (stride + 1) + 1 + x] + [0, left, up, (left + up) >> 1, paeth][filter]) & 255;
    }
  }
  const at = (x, y) => [...pixels.subarray(y * stride + x * channels, y * stride + x * channels + 3)];
  const box = (test) => {
    let [left, top, right, bottom] = [width, height, -1, -1];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (test(at(x, y))) [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
    if (right < 0) return null;
    return { x: left, y: top, width: right - left + 1, height: bottom - top + 1, middle: { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) } };
  };
  return { width, height, at, box };
}

/** RGBA rows as a PNG. */
function png(width, height, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6], 8);
  const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), rgba.subarray(y * width * 4, (y + 1) * width * 4)])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
