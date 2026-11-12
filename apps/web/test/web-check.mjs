// Drives the built web app in Chromium, Firefox and WebKit, served by a real
// zuna-web, against a real server and live bots. It checks what only the web app
// does, and that the shared interface works in each browser, and saves
// screenshots to look over.
//
//   npm run build -w @zuna/web && node apps/web/test/web-check.mjs [screenshot-dir] [chromium] [firefox] [webkit] [moz-firefox]
//
// With zuna-bot built too (npm run build:bot), it makes a bot, sets it up and talks to it.
//
// Needs Playwright's browsers: npx playwright-core install chromium firefox webkit
// Playwright's Firefox doesn't start on macOS 27 ("Could not find profile folder"), so moz-firefox runs
// the Firefox installed from Mozilla instead, through WebDriver BiDi.
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { LIVEKIT_CONFIG, ensureLiveKit, liveKitLogProblems, viteNodeArgs } from "../../../scripts/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const engines = { chromium, firefox, webkit, "moz-firefox": firefox };
const args = process.argv.slice(2);
const chosen = args.filter((arg) => arg in engines);
const shots = args.find((arg) => !(arg in engines)) ?? mkdtempSync(join(tmpdir(), "zuna-web-"));
mkdirSync(shots, { recursive: true });
const dist = join(root, "apps", "web", "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Build the web app first: npm run build -w @zuna/web");

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const goEnv = { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) };
const exe = process.platform === "win32" ? ".exe" : "";
const bin = mkdtempSync(join(tmpdir(), "zuna-web-bin-"));
for (const name of ["zuna-server", "zuna-web"]) {
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w -buildid=", "-o", join(bin, name + exe), `./cmd/${name}`], { cwd: join(root, "server"), env: goEnv, stdio: "inherit" });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomPort = () => 21000 + Math.floor(Math.random() * 20000);
const failures = [];
const notes = [];
let engine = "";
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${engine}: ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(`${engine}: ${name}`);
}

function start(command, commandArgs, options = {}) {
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

function stop(process_) {
  if (!process_) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(process_.child.pid), "/T", "/F"], { stdio: "ignore" });
    else process_.child.kill();
  } catch {
    // It may have exited already.
  }
}

async function waitFor(output, text, what) {
  for (let i = 0; i < 400; i++) {
    if (output().includes(text)) return;
    await sleep(50);
  }
  throw new Error(`${what} didn't start:\n${output()}`);
}

// YouTube's player, as a fake that speaks the same messages, and its pages for a video's title and picture,
// in place of YouTube's own: nothing here contacts YouTube.
const fakePlayer = readFileSync(join(root, "packages", "watch", "fake", "player.html"), "utf8");
const VIDEO = "aqz-KE-bpKQ";
async function fakeYouTube(browserContext, { breaksFirst = false } = {}) {
  // The first player can break as it starts, as YouTube's sometimes does, which the app gets past by loading it again.
  let players = 0;
  await browserContext.route("https://www.youtube-nocookie.com/**", (route) => {
    const body = breaksFirst && players++ === 0 ? fakePlayer.replace("<script>", "<script>window.fakeBreaks = true;</script>\n    <script>") : fakePlayer;
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
  });
  // The video's page and picture, fetched by zuna-web for whoever puts it on, as a link's preview is.
  await browserContext.route(/\/_zuna\/preview\?/, async (route) => {
    const url = new URL(route.request().url()).searchParams.get("url") ?? "";
    if (url.startsWith("https://www.youtube.com/watch")) {
      const body = `<html><head><meta property="og:title" content="A film about a rabbit"><meta property="og:image" content="https://i.ytimg.com/vi/${VIDEO}/maxresdefault.jpg"></head><body><span itemprop="author"><link itemprop="name" content="Blender"></span></body></html>`;
      return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "X-Zuna-Url": url }, body });
    }
    if (url.startsWith("https://i.ytimg.com/")) return route.fulfill({ status: 200, contentType: "image/png", headers: { "X-Zuna-Url": url }, body: picture });
    return route.continue();
  });
}

// A page with a title, a description and a picture, for link previews.
let picture = Buffer.alloc(0);
const siteHits = [];
const site = createServer((request, response) => {
  siteHits.push(request.url);
  if (request.url === "/lake.png") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(picture);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "tracker=1" });
  response.end(`<html><head><meta property="og:site_name" content="Lake Guide"><meta property="og:title" content="The quiet side of the lake">
    <meta property="og:description" content="Where to camp, swim and watch the sunset."><meta property="og:image" content="/lake.png"></head></html>`);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const article = `http://127.0.0.1:${site.address().port}/guide`;

// The test browsers won't send media to this machine's loopback address, so LiveKit says to use another of its addresses.
const lanAddress = Object.values(networkInterfaces()).flat().find((item) => item.family === "IPv4" && !item.internal)?.address ?? "127.0.0.1";

function launchOptions(name) {
  if (name === "chromium") return { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] };
  const prefs = { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } };
  if (name === "firefox") return prefs;
  if (name === "moz-firefox") return { ...prefs, channel: name };
  return {};
}

/** Firefox through WebDriver BiDi fills a field by setting its value, which React doesn't see, so there it types. */
async function fill(field, text, options) {
  if (engine !== "moz-firefox") return field.fill(text, options);
  await field.fill("", options);
  await field.pressSequentially(text);
}

async function signUp(page, link, serverName) {
  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await fill(page.getByLabel("Invite link"), link);
  await page.getByRole("button", { name: "Continue" }).click();
  await fill(page.getByPlaceholder("How people will see you"), "Alex Rivera", { timeout: 15_000 });
  await fill(page.getByLabel("Username"), "alex");
  await fill(page.locator('input[type="password"]').first(), "web-check-only-Pass-9182");
  await fill(page.getByLabel("Confirm password"), "web-check-only-Pass-9182");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await fill(page.getByPlaceholder("Our corner of the internet"), serverName);
  await page.getByRole("button", { name: "Finish" }).click();
  await page.locator(".conv-row").first().waitFor({ timeout: 20_000 });
}

/** The unread count the title should show: every badge, apart from muted chats. */
const unreadInList = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".conv-badge:not(.is-muted)")].reduce((sum, badge) => sum + Number(badge.textContent.replace("+", "")), 0));

/** What AVFoundation, which the iPhone plays voice and video messages with, makes of a file, decoding all of it. */
function appleReads(file) {
  const script = join(shots, "apple-reads.swift");
  writeFileSync(
    script,
    `import AVFoundation
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let videos = try await asset.loadTracks(withMediaType: .video)
let audios = try await asset.loadTracks(withMediaType: .audio)
var size = "none"
if let video = videos.first { let natural = try await video.load(.naturalSize); size = "\\(Int(natural.width))x\\(Int(natural.height))" }
var codec = "none"
if let audio = audios.first, let format = try await audio.load(.formatDescriptions).first {
  let type = CMFormatDescriptionGetMediaSubType(format)
  codec = String(bytes: [24, 16, 8, 0].map { UInt8((type >> $0) & 0xff) }, encoding: .ascii)!.trimmingCharacters(in: .whitespaces)
}
let reader = try AVAssetReader(asset: asset)
let sound = audios.first.map { AVAssetReaderTrackOutput(track: $0, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM]) }
let picture = videos.first.map { AVAssetReaderTrackOutput(track: $0, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]) }
for output in [sound, picture].compactMap({ $0 }) { reader.add(output) }
reader.startReading()
var heard = 0.0
var frames = 0
var reading = true
while reading {
  reading = false
  if let sound, let buffer = sound.copyNextSampleBuffer() { heard += CMSampleBufferGetDuration(buffer).seconds; reading = true }
  if let picture, picture.copyNextSampleBuffer() != nil { frames += 1; reading = true }
}
print("\\(size) \\(codec) \\(String(format: "%.2f", heard)) s \\(frames) frames\\(reader.status == .completed ? "" : ", failed")")
`,
  );
  try {
    const [size, sound, heard, , frames, , failed] = execFileSync("xcrun", ["swift", script, file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split(/[ ,]+/);
    return { size, sound, heard: Number(heard), frames: Number(frames), failed: failed === "failed", text: `${size}, ${sound}, ${heard} s, ${frames} frames${failed ? ", failed" : ""}` };
  } catch {
    return null;
  }
}

/**
 * A file the page made an address for, such as a decrypted attachment's. Its content security
 * policy doesn't let it fetch one, so the files are kept as they're given addresses.
 */
const bytesAt = (page, url) =>
  page.evaluate(async (address) => {
    const bytes = new Uint8Array(await window.__files.get(address).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }, url);

async function runIn(name) {
  engine = name;
  const prefix = (shot) => join(shots, `${name}-${shot}.png`);
  const data = mkdtempSync(join(tmpdir(), "zuna-web-data-"));
  const serverPort = randomPort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const liveKitPort = randomPort();
  const liveKit = start(ensureLiveKit(), ["--dev", "--bind", lanAddress, "--bind", "127.0.0.1", "--node-ip", lanAddress, "--port", String(liveKitPort), "--config-body", LIVEKIT_CONFIG]);
  const server = start(join(bin, `zuna-server${exe}`), ["--listen", `127.0.0.1:${serverPort}`, "--data", data, "--public-url", serverUrl, "--auth-burst", "1000", "--push-relays", "off", "--livekit-internal-url", `http://127.0.0.1:${liveKitPort}`, "--livekit-key", "devkey", "--livekit-secret", "secret"]);
  const webPort = randomPort();
  const web = start(join(bin, `zuna-web${exe}`), ["--listen", `127.0.0.1:${webPort}`, "--root", dist, "--dev"]);
  const appUrl = `http://localhost:${webPort}/`;
  let context;
  let fresh;
  let elsewhere;
  let leaver;
  let bots;
  let botProgram;
  const errors = [];
  try {
    await waitFor(server.output, "/invite/", "the server");
    const link = server.output().match(/http:\/\/\S+\/invite\/\S+/)[0];
    await waitFor(web.output, "Listening on", "zuna-web");

    // A browser's own profile, as people use: Safari keeps no files for a private window.
    const profile = () => engines[name].launchPersistentContext(mkdtempSync(join(tmpdir(), `zuna-web-${name}-`)), { ...launchOptions(name), viewport: { width: 1280, height: 800 } });
    context = await profile();
    if (!name.endsWith("firefox")) await context.grantPermissions(["microphone", "camera"], { origin: appUrl.slice(0, -1) }).catch(() => undefined);
    // A request to the server cut off as a tab reloads or hands over, such as a read
    // position on its way, is one WebKit reports as failing its access control checks.
    // That's only expected while this check is itself reloading, handing over or
    // closing a tab: a real failure of those checks would come on every request.
    const leaving = new Set();
    let cutOffs = 0;
    const cutOff = (page, text) => leaving.has(page) && /^Fetch API cannot load .* due to access control checks\.$/.test(text) && ++cutOffs > 0;
    const watch = (page, label) => {
      // WebKit reports a ResizeObserver that runs late as an error. It's harmless, and the desktop's Chromium doesn't.
      page.on("pageerror", (error) => !/ResizeObserver loop/.test(error.message) && errors.push(`${label}: ${error.message}`));
      page.on("console", (message) => {
        const text = message.text();
        if (message.type() === "error" && !/WebSocket|Failed to load resource|ResizeObserver loop/.test(text) && !cutOff(page, text)) errors.push(`${label}: ${text}`);
        if (/Content.Security.Policy/i.test(text)) errors.push(`${label}: ${text}`);
      });
    };
    // The browser's notifications, kept to look at rather than shown, as if allowed.
    await context.addInitScript(() => {
      const shown = (window.__notifications = []);
      window.Notification = class {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title, options = {}) {
          Object.assign(this, options, { title, closed: false });
          shown.push(this);
        }
        close() {
          this.closed = true;
          this.onclose?.();
        }
      };
    });
    const page = context.pages()[0] ?? (await context.newPage());
    watch(page, "first tab");

    // Starting, and what the host sends
    const response = await page.goto(appUrl);
    const headers = response.headers();
    check("the page comes with the content security policy", (headers["content-security-policy"] ?? "").includes("script-src 'self' 'wasm-unsafe-eval'"));
    await page.getByRole("button", { name: "Join with an invite" }).waitFor({ timeout: 30_000 });
    check("the app starts", true);
    await page.screenshot({ path: prefix("01-welcome") });

    await signUp(page, link, "Friends");
    check("signing up works", true);

    // Unread messages from live bots, counted in the title
    await page.locator(".server-title").click();
    await page.getByRole("menuitem", { name: "Invite people" }).click();
    await page.getByRole("button", { name: "Create invite link" }).click();
    const invite = await page.locator(".invite-link span").first().textContent({ timeout: 10_000 });
    await page.keyboard.press("Escape");

    // An invite link opened from outside goes ahead by itself, once: Back stays on the link.
    await page.evaluate((link) => (location.hash = `join=${encodeURIComponent(link)}`), invite);
    await page.getByRole("heading", { name: "Join Friends" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Back" }).click();
    await sleep(1500);
    const linkField = page.getByLabel("Invite link");
    check(
      "Back from a link opened from outside stays on the link",
      (await linkField.count()) === 1 && (await linkField.inputValue()) === invite && !(await page.getByRole("heading", { name: "Join Friends" }).isVisible()),
    );
    await page.keyboard.press("Escape");
    bots = start(...viteNodeArgs("test/dev-bots.ts", invite), { cwd: join(root, "packages", "core") });
    await waitFor(bots.output, "Bots are ready", "the bots").catch(async () => {
      for (let i = 0; i < 1200 && !bots.output().includes("Bots are ready"); i++) await sleep(100);
      if (!bots.output().includes("Bots are ready")) throw new Error(`the bots didn't start:\n${bots.output()}`);
    });
    await page.locator(".conv-row", { hasText: "Weekend trip" }).waitFor({ timeout: 20_000 });
    await page.locator(".conv-badge").first().waitFor({ timeout: 20_000 });
    await sleep(1500);
    const unread = await unreadInList(page);
    const title = await page.title();
    check("the tab's title counts unread messages", unread > 0 && title === `(${unread}) Zuna`, `${title}, ${unread} in the list`);
    await page.screenshot({ path: prefix("02-list") });

    const row = page.locator(".conv-row", { has: page.locator(".conv-badge:not(.is-muted)") }).first();
    const rowUnread = Number(await row.locator(".conv-badge").textContent());
    await row.click();
    await page.locator(".bubble").first().waitFor({ timeout: 10_000 });
    // It opens at the first unread message, reading only what's on screen, and the way down reads the rest.
    check("a chat with unread messages opens under a line", (await page.locator(".unread-sep").count()) === 1);
    await sleep(500);
    const down = page.locator(".to-bottom:not(.to-mention)");
    if (await down.count()) await down.click();
    await sleep(1500);
    const after = await page.title();
    const expected = unread - rowUnread;
    check("reading a chat takes it off the title", after === (expected > 0 ? `(${expected}) Zuna` : "Zuna"), `${title} became ${after}`);

    // Sending, with a link preview fetched by zuna-web
    await page.locator(".conv-row", { hasText: "Priya" }).click();
    await page.locator(".composer-input").click();
    picture = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 600;
        canvas.height = 400;
        const context = canvas.getContext("2d");
        context.fillStyle = "#3a4a55";
        context.fillRect(0, 0, 600, 400);
        return canvas.toDataURL("image/png").split(",")[1];
      }),
      "base64",
    );
    siteHits.length = 0;
    await page.keyboard.type(`This is the spot ${article}`);
    await page.locator(".link-draft", { hasText: "The quiet side of the lake" }).waitFor({ timeout: 15_000 });
    check("writing a link shows its preview, picture and all", siteHits.includes("/lake.png"), siteHits.join(", "));
    await page.keyboard.press("Enter");
    await page.locator(".msg.is-own .link-card", { hasText: "The quiet side of the lake" }).waitFor({ timeout: 15_000 });
    await page.locator(".msg.is-other", { hasText: "You said" }).waitFor({ timeout: 20_000 });
    check("a message with a preview is sent and answered", true);
    await page.screenshot({ path: prefix("03-dm") });

    // A picture, sent and shown
    await page.locator('input[type="file"]').setInputFiles([{ name: "lake.png", mimeType: "image/png", buffer: picture }]);
    await page.locator(".file-chip").waitFor();
    await page.keyboard.press("Enter");
    await page.locator(".msg.is-own .media-full").last().waitFor({ timeout: 20_000 });
    check("a picture is sent and shown", true);

    // The chat's photos and links, from its details
    await page.locator(".chat-title").click();
    await page.locator(".side-row", { hasText: "shared link" }).click();
    await page.locator(".shared-link-title", { hasText: "The quiet side of the lake" }).waitFor({ timeout: 10_000 });
    await page.getByLabel("Back to details").click();
    await page.locator(".side-row", { hasText: "1 photo" }).click();
    await page.locator(".shared-tile-full").waitFor({ timeout: 15_000 });
    check("the chat's details list its links and photos", true);
    await page.screenshot({ path: prefix("03b-shared") });
    await page.locator(".side-head").getByLabel("Close").click();

    // Two pictures in another chat, which the viewer goes between, the older on the left, as Telegram's does
    await page.locator(".conv-row", { has: page.locator(".conv-title", { hasText: "Sam Chen" }) }).click();
    for (const name of ["lake-1.png", "lake-2.png"]) {
      await page.locator('input[type="file"]').setInputFiles([{ name, mimeType: "image/png", buffer: picture }]);
      await page.locator(".file-chip").waitFor();
      await page.keyboard.press("Enter");
      await page.locator(".file-chip").waitFor({ state: "detached" });
    }
    await page.getByRole("button", { name: "Open lake-2.png" }).click({ timeout: 20_000 });
    const viewer = page.locator(".image-viewer");
    await viewer.locator('img[alt="lake-2.png"]').waitFor({ timeout: 10_000 });
    const place = viewer.locator(".image-count");
    check("the viewer says which picture of how many", (await place.innerText()) === "2 of 2", await place.innerText());
    await page.keyboard.press("ArrowLeft");
    await viewer.locator('img[alt="lake-1.png"]').waitFor({ timeout: 10_000 });
    check("the left arrow key goes to the one before, the first", (await place.innerText()) === "1 of 2" && (await viewer.locator(".image-nav.is-before").count()) === 0);
    await page.screenshot({ path: prefix("03c-viewer") });
    await viewer.locator(".image-nav.is-after").click();
    await viewer.locator('img[alt="lake-2.png"]').waitFor({ timeout: 10_000 });
    check("the arrow on the right goes to the next", (await place.innerText()) === "2 of 2" && (await viewer.locator(".image-nav.is-after").count()) === 0);
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "detached" });
    await page.locator(".conv-row", { hasText: "Priya" }).click();

    // Voice messages: what each browser can record, and whether an iPhone could play what it sends
    const formats = await page.evaluate(() =>
      ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus"].filter((type) => window.MediaRecorder?.isTypeSupported(type)),
    );
    notes.push(`${name} records: ${formats.join(", ") || "nothing"}`);
    // The player the app makes for a voice message, for the file it plays.
    await page.evaluate(() => {
      window.__files = new Map();
      const address = URL.createObjectURL;
      URL.createObjectURL = (file) => {
        const url = address(file);
        window.__files.set(url, file);
        return url;
      };
      const Player = window.Audio;
      window.Audio = class extends Player {
        constructor(source) {
          super(source);
          window.__player = this;
        }
      };
    });
    try {
      await page.getByLabel("Record a voice message").click();
      await page.locator(".recording-row").waitFor({ timeout: 10_000 });
      await sleep(1500);
      await page.getByLabel("Send voice message").click();
      const voice = page.locator(".msg.is-own .voice").last();
      await voice.locator(".voice-play[aria-label='Play voice message']").waitFor({ timeout: 15_000 });
      check("a voice message is recorded and sent", true, await voice.locator(".voice-time").innerText());
      if (process.platform === "darwin") {
        await voice.locator(".voice-play").click();
        const played = await page.waitForFunction(() => window.__player?.src, null, { timeout: 15_000 }).then((handle) => handle.jsonValue());
        await page.evaluate(() => window.__player.pause());
        const file = join(shots, `${name}-voice.m4a`);
        writeFileSync(file, Buffer.from(await bytesAt(page, played), "base64"));
        const read = appleReads(file);
        // Playwright's WebKit starts its microphone late: 0.86 s of a 1.5 s recording on 2026-11-04.
        check("an iPhone could play the voice messages this browser sends", !!read && /^(aac|opus)$/.test(read.sound) && read.heard > 0.5 && !read.failed, read?.text ?? "unreadable to AVFoundation");
      }
      // How fast it plays, from the speed beside its time once it's started, as Telegram's.
      const speed = voice.locator(".voice-speed");
      if (!(await speed.count())) await voice.locator(".voice-play").click();
      await speed.waitFor({ timeout: 10_000 });
      const first = await speed.innerText();
      await speed.click();
      await speed.click();
      const rate = await page.evaluate(() => window.__player?.playbackRate);
      const now = await speed.innerText();
      check("a voice message plays at 1×, 1.5× and 2× from the speed beside its time", first === "1×" && now === "2×" && rate === 2, `${first}, then ${now}, playing at ${rate}`);
      await speed.click();
      await page.evaluate(() => window.__player?.pause());
    } catch (error) {
      check("a voice message is recorded and sent", false, error.message.split("\n")[0]);
    }

    // Video messages: recorded from the camera, sent, and shown as a circle; and whether an iPhone could play what this browser sends.
    const videoFormats = await page.evaluate(() =>
      ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,opus", "video/mp4", "video/webm;codecs=vp8,opus"].filter((type) => window.MediaRecorder?.isTypeSupported(type)),
    );
    notes.push(`${name} records video messages as: ${videoFormats[0] ?? "nothing"}`);
    try {
      await page.getByLabel("Record a video message").click();
      await page.locator(".round-preview video").waitFor({ timeout: 10_000 });
      await sleep(2000);
      await page.getByLabel("Send video message").click();
      const round = page.locator(".msg.is-own.is-round .round").last();
      await round.locator("video").waitFor({ timeout: 20_000 });
      const size = await round.locator("video").evaluate((video) => new Promise((resolve) => setTimeout(() => resolve(`${video.videoWidth}x${video.videoHeight}`), 1000)));
      check("a video message is recorded, sent and shown as a circle", size === "480x480", size);
      await page.screenshot({ path: prefix("03e-video-message") });
      if (process.platform === "darwin") {
        const file = join(shots, `${name}-round.mp4`);
        writeFileSync(file, Buffer.from(await bytesAt(page, await round.locator("video").evaluate((video) => video.currentSrc)), "base64"));
        const read = appleReads(file);
        check("an iPhone could play the video messages this browser sends", !!read && read.size === "480x480" && read.frames > 0 && read.sound !== "none" && read.heard > 0 && !read.failed, read?.text ?? "unreadable to AVFoundation");
      }
    } catch (error) {
      check("a video message is recorded, sent and shown as a circle", false, error.message.split("\n")[0]);
    }

    // Sharing a location: the host's headers have to let the page ask where it is.
    try {
      await context.grantPermissions(["geolocation"], { origin: appUrl.slice(0, -1) });
      await context.setGeolocation({ latitude: 52.229676, longitude: 21.012229, accuracy: 25 });
      await page.getByLabel("Attach", { exact: true }).click();
      await page.getByRole("menuitem", { name: "Location" }).click();
      await page.locator(".share-location", { hasText: "52.22968° N, 21.01223° E" }).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Send location" }).click();
      await page.locator(".msg.is-own .location-card").last().waitFor({ timeout: 10_000 });
      check("a location is found and shared", true);
    } catch (error) {
      check("a location is found and shared", false, (await page.locator(".share-location").innerText().catch(() => "")) || error.message.split("\n")[0]);
      await page.keyboard.press("Escape");
    }

    // A reply in a chat that isn't open shows a notification, which reading the chat takes back.
    const notification = (text) =>
      page.evaluate((text) => {
        const found = window.__notifications.find((item) => item.body?.includes(text));
        return found && { title: found.title, body: found.body, icon: found.icon, silent: found.silent, closed: found.closed };
      }, text);
    await page.locator(".composer-input").click();
    await page.keyboard.type("Ping me back");
    await page.keyboard.press("Enter");
    await page.locator(".conv-row", { hasText: "Weekend trip" }).click();
    try {
      await page.waitForFunction(() => window.__notifications.some((item) => item.body?.includes("You said: Ping me back")), null, { timeout: 15_000 });
      const shown = await notification("You said: Ping me back");
      check("a reply in another chat shows a notification", shown.title.includes("Priya") && shown.icon === "/icon-192.png" && shown.silent === true, JSON.stringify(shown));
      // Answers to what was sent before may have come too, so it opens above them: the way down reads them.
      await page.locator(".conv-row", { hasText: "Priya" }).click();
      await sleep(500);
      const toNewest = page.locator(".to-bottom:not(.to-mention)");
      if (await toNewest.count()) await toNewest.click();
      await page.waitForFunction(() => window.__notifications.find((item) => item.body?.includes("You said: Ping me back"))?.closed, null, { timeout: 10_000 });
      check("reading the chat takes its notification back", true);
    } catch (error) {
      check("a reply in another chat shows a notification, until the chat is read", false, JSON.stringify(await notification("You said: Ping me back")) ?? error.message.split("\n")[0]);
    }

    // A message found by search opens in a window around it, which reads on both ways, and takes new messages once it has read on to the newest
    try {
      await page.locator(".conv-row", { has: page.locator(".conv-title", { hasText: "Jordan Blake" }) }).click();
      await page.locator(".composer-input").click();
      await page.keyboard.type("count to 160");
      await page.keyboard.press("Enter");
      // Whether "Count n" is drawn, without the time at the end of a message's text.
      const shows = (n) =>
        page.evaluate(
          (text) =>
            [...document.querySelectorAll(".msg-text")].some((element) => {
              const copy = element.cloneNode(true);
              for (const meta of copy.querySelectorAll(".msg-meta")) meta.remove();
              return copy.textContent.trim() === text;
            }),
          `Count ${n}`,
        );
      const down = page.locator(".to-bottom:not(.to-mention)");
      for (let i = 0; i < 240 && !(await shows(160)); i++) {
        if (await down.count()) await down.click();
        await sleep(500);
      }
      await fill(page.locator("#conversation-search"), "Count 60");
      await page.locator(".hit-row", { has: page.locator(".conv-preview", { hasText: /^Count 60$/ }) }).click({ timeout: 15_000 });
      for (let i = 0; i < 30 && !(await shows(60)); i++) await sleep(500);
      await fill(page.locator("#conversation-search"), "");
      check("a message found by search opens away from the newest", (await shows(60)) && !(await shows(160)) && (await down.count()) === 1);
      const scroller = page.locator(".message-list .virtuoso");
      for (let i = 0; i < 80 && !(await shows(1)); i++) {
        await scroller.evaluate((element) => element.scrollBy(0, -element.clientHeight));
        await sleep(200);
      }
      check("reading up from it loads older messages", await shows(1));
      for (let i = 0; i < 120 && !(await shows(160)); i++) {
        await scroller.evaluate((element) => element.scrollBy(0, element.clientHeight));
        await sleep(200);
      }
      check("reading down from it loads newer ones, to the newest", await shows(160));
      await scroller.evaluate((element) => element.scrollBy(0, element.scrollHeight));
      await sleep(800);
      check("there it's at the newest, with no way down", (await down.count()) === 0);
      await page.locator(".composer-input").click();
      await page.keyboard.type("Read it all");
      await page.keyboard.press("Enter");
      await page.locator(".msg.is-other .msg-text", { hasText: "You said: Read it all" }).waitFor({ timeout: 20_000 });
      check("then it takes new messages as they come", await shows(160));
      await page.screenshot({ path: prefix("03d-read-on") });
    } catch (error) {
      check("a window around a message found reads on both ways", false, error.message.split("\n")[0]);
      await page.screenshot({ path: prefix("03d-read-on") });
      await fill(page.locator("#conversation-search"), "").catch(() => undefined);
    }

    // Everything is still there after a reload
    leaving.add(page);
    await page.reload();
    leaving.delete(page);
    await page.locator(".conv-row", { hasText: "Priya" }).waitFor({ timeout: 30_000 });
    await page.locator(".conv-row", { hasText: "Priya" }).click();
    await page.locator(".msg.is-own .link-card", { hasText: "The quiet side of the lake" }).waitFor({ timeout: 15_000 });
    check("a reload keeps the account and the messages", true);

    // One tab at a time
    const second = await context.newPage();
    watch(second, "second tab");
    await second.goto(appUrl);
    await second.getByText("Zuna is open in another tab").waitFor({ timeout: 15_000 });
    check("a second tab says Zuna is open elsewhere", (await page.locator(".conv-row").count()) > 0);
    await second.screenshot({ path: prefix("04-other-tab") });
    leaving.add(page);
    await second.getByRole("button", { name: "Use here" }).click();
    await second.locator(".conv-row", { hasText: "Priya" }).waitFor({ timeout: 30_000 });
    await page.getByText("Zuna is open in another tab").waitFor({ timeout: 15_000 });
    check("Use here moves the app to the second tab", (await page.title()) === "Zuna", `first tab's title: ${await page.title()}`);
    await second.locator(".conv-row", { hasText: "Priya" }).click();
    await second.locator(".msg.is-own .link-card", { hasText: "The quiet side of the lake" }).waitFor({ timeout: 15_000 });
    check("the second tab has the same messages", true);
    await page.close();

    // A window too small for the layout
    await second.setViewportSize({ width: 700, height: 600 });
    await sleep(200);
    check("a narrow window asks to be made bigger", await second.locator(".narrow-notice").isVisible());
    await second.screenshot({ path: prefix("05-narrow") });
    await second.setViewportSize({ width: 1280, height: 800 });

    // Settings that differ on the web
    await second.getByLabel("Settings").click();
    await second.getByText("Notifications", { exact: true }).first().click();
    check("notifications can be turned off", (await second.getByText("Desktop notifications").count()) === 1 && (await second.getByText("Away from the computer after").count()) === 0);
    await sleep(400);
    await second.screenshot({ path: prefix("05b-notifications") });
    await second.getByText("Security", { exact: true }).first().click();
    check("Security warns that the browser can't protect the key", (await second.getByText("Browsers can't lock Zuna's local data").count()) === 1);
    const deviceName = await second.locator(".device-row", { hasText: "This device" }).innerText();
    check("this browser is named in Devices", /(Chrome|Firefox|Safari|Edge|Browser) on \w+/.test(deviceName), deviceName.split("\n")[0]);
    await second.screenshot({ path: prefix("06-security") });
    // Your data: what the server keeps, in plain words, and saved as the server's own answer.
    await second.getByText("Your data", { exact: true }).first().click();
    await second.locator(".data-section").first().waitFor({ timeout: 15_000 });
    const usernameTag = await second.locator(".data-row", { hasText: "Username" }).first().locator(".data-tag").innerText();
    check("Your data marks what it reads apart from what it can't", usernameTag === "Readable" && (await second.locator(".data-tag", { hasText: "Encrypted" }).count()) > 0, usernameTag);
    const [download] = await Promise.all([second.waitForEvent("download"), second.getByRole("button", { name: "Save as file" }).click()]);
    const savedData = JSON.parse(readFileSync(await download.path(), "utf8"));
    check("it saves the server's answer, without the sign-in checks", /^zuna-.+\.json$/.test(download.suggestedFilename()) && !!savedData.account?.id && !("auth_hash" in (savedData.sign_in ?? {})), download.suggestedFilename());
    await second.screenshot({ path: prefix("06b-server-data") });
    await second.keyboard.press("Escape");

    // A browser whose data was cleared signs in again, and the history comes back from the vault.
    // Playwright's WebKit profiles share the origin-private file system, so this one also
    // finds a database it has no key for, which it has to clear rather than fail on.
    leaving.add(second);
    await context.close();
    context = undefined;
    fresh = await profile();
    // Each wake lock the app asks for, and what the browser said.
    await fresh.addInitScript(() => {
      const asked = (window.__wakeLocks = []);
      if (!window.WakeLock) return;
      const request = WakeLock.prototype.request;
      WakeLock.prototype.request = function (type) {
        const entry = { type, lock: null, refused: "" };
        asked.push(entry);
        return request.call(this, type).then(
          (lock) => (entry.lock = lock),
          (error) => {
            entry.refused = error.name;
            throw error;
          },
        );
      };
    });
    // Each stream the app opens on the microphone or camera, to tell whether it let them go.
    await fresh.addInitScript(() => {
      const streams = (window.__streams = []);
      const devices = navigator.mediaDevices;
      if (!devices?.getUserMedia) return;
      const getUserMedia = devices.getUserMedia.bind(devices);
      devices.getUserMedia = (constraints) => getUserMedia(constraints).then((stream) => (streams.push(stream), stream));
    });
    let again = fresh.pages()[0] ?? (await fresh.newPage());
    watch(again, "fresh browser");
    await again.goto(appUrl);
    await again.getByRole("button", { name: "Sign in", exact: true }).click();
    await fill(again.getByLabel("Server address"), serverUrl);
    await fill(again.getByLabel("Username"), "alex");
    await fill(again.locator('input[type="password"]'), "web-check-only-Pass-9182");
    await again.getByRole("button", { name: "Sign in", exact: true }).click();
    await again.locator(".conv-row", { hasText: "Priya" }).waitFor({ timeout: 45_000 });
    await again.locator(".conv-row", { hasText: "Priya" }).click();
    await again.locator(".msg.is-own", { hasText: "This is the spot" }).waitFor({ timeout: 45_000 });
    check("signing in again brings the history back", true);
    await again.screenshot({ path: prefix("07-signed-in-again") });

    // Channels and voice, under this host's content security policy
    again.on("console", (message) => message.text().includes("[zuna]") && console.log(`  ${message.text()}`));
    await again.locator(".channel-empty button").click();
    await fill(again.getByPlaceholder("new-channel"), "general");
    await again.getByRole("button", { name: "Create channel" }).click();
    await again.locator(".chat-title", { hasText: "general" }).waitFor({ timeout: 15_000 });
    await fill(again.locator(".composer-input"), "hello channel");
    await again.keyboard.press("Enter");
    await again.locator(".msg.is-channel", { hasText: "hello channel" }).waitFor({ timeout: 15_000 });
    check("a text channel works", true);
    await again.locator(".channel-section-head", { hasText: "Text channels" }).hover();
    await again.getByRole("button", { name: /New channel in Text channels/ }).click();
    await again.getByRole("button", { name: /^Voice/ }).click();
    await fill(again.getByPlaceholder("Lounge"), "Lounge");
    await again.getByRole("button", { name: "Create channel" }).click();
    await again.locator(".channel-row", { hasText: "Lounge" }).click();
    await again.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
    check("a voice channel connects, encrypted", true);
    await again.waitForFunction(() => document.querySelector(".voice-control.is-live, .voice-control.is-off"), null, { timeout: 15_000 });
    await sleep(1000);
    await again.screenshot({ path: prefix("08-voice") });
    await again.getByRole("button", { name: "Stream stats" }).click();
    const connection = again.locator(".stream-stats-section", { hasText: "Connection" });
    await connection.waitFor({ timeout: 5000 });
    check("stream stats read the call", (await connection.innerText()).includes("End to end"));
    await again.getByRole("button", { name: "Close stream stats" }).click();

    // A camera on the call keeps the screen on, and only while it's there.
    const awake = () =>
      again.evaluate(() => ({
        asked: window.__wakeLocks.length,
        held: window.__wakeLocks.some((entry) => entry.lock && !entry.lock.released),
        refused: window.__wakeLocks.find((entry) => entry.refused)?.refused ?? "",
      }));
    check("a call with no video lets the screen sleep", (await awake()).asked === 0);
    // Playwright's WebKit refuses what isn't on the list it's given, and this profile has no camera until it is.
    if (name === "webkit") await fresh.grantPermissions(["camera", "screen-wake-lock"], { origin: appUrl.slice(0, -1) });
    await again.getByRole("toolbar", { name: "Call" }).getByRole("button", { name: "Turn on camera" }).click();
    await again.locator(".voice-video").first().waitFor({ timeout: 15_000 });
    await again.waitForFunction(() => window.__wakeLocks.some((entry) => entry.lock || entry.refused), null, { timeout: 5000 }).catch(() => undefined);
    const lit = await awake();
    // Playwright's Chromium is a headless shell, which refuses every page a wake lock. Full Chromium holds it.
    check("a camera on the call keeps the screen on", lit.held || (name === "chromium" && lit.refused === "NotAllowedError"), lit.held ? "held" : `asked ${lit.asked}, ${lit.refused || "no answer"}`);
    await again.getByRole("toolbar", { name: "Call" }).getByRole("button", { name: "Turn off camera" }).click();
    await again.waitForFunction(() => !window.__wakeLocks.some((entry) => entry.lock && !entry.lock.released), null, { timeout: 5000 }).catch(() => undefined);
    check("turning the camera off lets the screen sleep again", !(await awake()).held);
    await again.getByRole("button", { name: "Disconnect from voice" }).click();
    await again.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 });

    // Another tab taking over leaves voice here, rather than keeping the microphone and the call going.
    await again.locator(".channel-row", { hasText: "Lounge" }).click();
    await again.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
    const live = () => again.evaluate(() => window.__streams.flatMap((stream) => stream.getTracks()).filter((track) => track.readyState === "live").map((track) => track.kind));
    const liveBefore = await live();
    const taker = await fresh.newPage();
    watch(taker, "tab taking over");
    await taker.goto(appUrl);
    await taker.getByText("Zuna is open in another tab").waitFor({ timeout: 15_000 });
    leaving.add(again);
    await taker.getByRole("button", { name: "Use here" }).click();
    await again.getByText("Zuna is open in another tab").waitFor({ timeout: 30_000 });
    const liveAfter = await live();
    check("Use here leaves voice in the tab it took over from", liveAfter.length === 0, `live before: ${liveBefore.join(" ") || "none"}, after: ${liveAfter.join(" ") || "none"}`);
    await taker.locator(".conv-row", { hasText: "Priya" }).waitFor({ timeout: 45_000 });
    await again.close();
    again = taker;

    // Coming into voice while another of this person's devices is in it asks first, and only a yes takes that one out.
    elsewhere = await profile();
    const other = elsewhere.pages()[0] ?? (await elsewhere.newPage());
    watch(other, "second device");
    await other.goto(appUrl);
    await other.getByRole("button", { name: "Sign in", exact: true }).click();
    await fill(other.getByLabel("Server address"), serverUrl);
    await fill(other.getByLabel("Username"), "alex");
    await fill(other.locator('input[type="password"]'), "web-check-only-Pass-9182");
    await other.getByRole("button", { name: "Sign in", exact: true }).click();
    // The device alex was on asks whether that was them, over everything, until they answer.
    const newDevice = again.locator(".new-device");
    await newDevice.waitFor({ timeout: 30_000 });
    await again.keyboard.press("Escape");
    await again.mouse.click(8, 8);
    await sleep(300);
    check(
      "a device signing in to the account is asked about on the other, and Escape or a click outside doesn't send it away",
      (await newDevice.count()) === 1 && (await newDevice.innerText()).includes("Was this you?"),
    );
    await again.screenshot({ path: prefix("08-new-device") });
    await newDevice.getByRole("button", { name: "Yes, it was me" }).click();
    await newDevice.waitFor({ state: "detached", timeout: 10_000 });
    await other.locator(".channel-row", { hasText: "Lounge" }).click({ timeout: 45_000 });
    await other.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
    await again.locator(".voice-occupant").waitFor({ timeout: 15_000 });
    await again.locator(".conv-row", { hasText: "Priya" }).click();
    await again.locator(".channel-row", { hasText: "Lounge" }).click();
    const askMove = again.locator(".modal", { hasText: "Join on this device?" });
    await askMove.waitFor({ timeout: 5_000 });
    await sleep(300);
    await again.screenshot({ path: prefix("08-voice-elsewhere") });
    const asked = await askMove.innerText();
    await askMove.getByRole("button", { name: "Cancel" }).click();
    await askMove.waitFor({ state: "detached", timeout: 5_000 });
    await sleep(1000);
    check(
      "coming into voice while another device is in it asks first, and Cancel changes nothing",
      asked.includes("You're in this voice channel on another device.") && (await again.locator(".voice-panel").count()) === 0 && (await again.locator(".chat-title", { hasText: "Priya" }).count()) === 1 && (await other.locator(".voice-panel-status.is-connected").count()) === 1,
      asked.replace(/\n/g, " "),
    );
    await again.locator(".channel-row", { hasText: "Lounge" }).click();
    await askMove.getByRole("button", { name: "Join here" }).click();
    await again.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
    await other.getByText("You joined this voice channel on another device.").waitFor({ timeout: 15_000 });
    check("Join here comes in, and takes the other device out", (await other.locator(".voice-panel").count()) === 0 && (await again.locator(".voice-occupant").count()) === 1);
    await again.getByRole("button", { name: "Disconnect from voice" }).click();
    await again.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 });
    leaving.add(other);
    await elsewhere.close();
    elsewhere = undefined;

    // Someone deletes their account, and the app lets go of the server.
    leaver = await profile();
    const gone = leaver.pages()[0] ?? (await leaver.newPage());
    watch(gone, "deleting browser");
    await gone.goto(appUrl);
    await gone.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
    await fill(gone.getByLabel("Invite link"), invite);
    await gone.getByRole("button", { name: "Continue" }).click();
    await fill(gone.getByPlaceholder("How people will see you"), "Lee Leaving", { timeout: 15_000 });
    await fill(gone.getByLabel("Username"), "leaving.check");
    await fill(gone.locator('input[type="password"]').first(), "web-check-only-Pass-5531");
    await fill(gone.getByLabel("Confirm password"), "web-check-only-Pass-5531");
    await gone.getByRole("button", { name: "Create account" }).click();
    await gone.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
    await gone.getByText("I've stored it somewhere safe").click();
    await gone.getByRole("button", { name: "Continue" }).click();
    await gone.locator(".conv-row").first().waitFor({ timeout: 20_000 });
    await again.locator(".conv-row", { hasText: "Lee Leaving" }).waitFor({ timeout: 20_000 });

    // Watching a video together in a voice channel, with the fake player in place of YouTube's.
    await fakeYouTube(fresh, { breaksFirst: true });
    await fakeYouTube(leaver);
    const playerOf = (where) => where.frameLocator(".watch-frame");
    // Nothing until the fake's script has run: a frame just made has its address before its page.
    const fakeOf = async (where) => {
      const frame = where.frames().find((item) => item.url().startsWith("https://www.youtube-nocookie.com/embed/"));
      if (!frame) return null;
      return frame.evaluate(() => (window.fake ? { id: window.fake.id, time: window.fake.time, state: window.fake.state, rate: window.fake.rate } : null)).catch(() => null);
    };
    await again.locator(".channel-row", { hasText: "Lounge" }).click();
    await again.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
    await gone.locator(".channel-row", { hasText: "Lounge" }).click({ timeout: 20_000 });
    await gone.locator(".voice-panel-status.is-connected").waitFor({ timeout: 30_000 });
    await again.getByRole("toolbar", { name: "Call" }).getByRole("button", { name: "Watch together" }).click();
    const consent = again.locator(".modal", { hasText: "Play YouTube videos?" });
    await consent.waitFor({ timeout: 5_000 });
    const consentText = await consent.innerText();
    await consent.getByRole("button", { name: "Continue" }).click();
    await fill(again.getByLabel("YouTube link"), "https://vimeo.com/1");
    await again.getByRole("button", { name: "Put it on" }).click();
    const refused = await again.locator(".field-error").innerText({ timeout: 5_000 });
    await fill(again.getByLabel("YouTube link"), `https://youtu.be/${VIDEO}?t=30`);
    await again.getByRole("button", { name: "Put it on" }).click();
    await again.locator(".watch-frame").waitFor({ timeout: 15_000 });
    let loadedAgain = null;
    for (let i = 0; i < 40 && loadedAgain?.state !== 1; i++, await sleep(250)) loadedAgain = await fakeOf(again);
    check("a player that breaks as it starts is loaded again, and plays", loadedAgain?.state === 1, `state ${loadedAgain?.state}`);
    check(
      "putting a video on asks first what Google learns, and refuses what isn't YouTube's",
      consentText.includes("Google learns this device's IP address") && /isn't a link to a YouTube video/.test(refused),
      refused,
    );
    // Until Lee presses Watch, their device shows what came inside the room's state and contacts nobody.
    const cover = gone.locator(".watch-cover");
    await cover.waitFor({ timeout: 15_000 });
    const coverText = await cover.innerText();
    const before = await fakeOf(gone);
    check("the video shows to the others with its title and picture, and loads nothing until Watch", coverText.includes("A film about a rabbit") && coverText.includes("Alex Rivera") && (await gone.locator(".watch-cover img").count()) === 1 && before === null, coverText.replace(/\n/g, " "));
    await sleep(300);
    await gone.screenshot({ path: prefix("08b-watch-cover") });
    await cover.getByRole("button", { name: "Watch" }).click();
    await gone.locator(".modal", { hasText: "Play YouTube videos?" }).getByRole("button", { name: "Watch" }).click();
    await gone.locator(".watch-frame").waitFor({ timeout: 15_000 });
    const playing = async () => {
      const [a, b] = await Promise.all([fakeOf(again), fakeOf(gone)]);
      return a && b && a.state === 1 && b.state === 1 && a.id === VIDEO && b.id === VIDEO ? Math.abs(a.time - b.time) : null;
    };
    let apart = null;
    for (let i = 0; i < 60 && (apart === null || apart > 0.5); i++, await sleep(250)) apart = await playing();
    check("both play it at the same moment", apart !== null && apart < 0.5, `${apart?.toFixed(2)} s apart`);
    await sleep(500);
    await again.screenshot({ path: prefix("08b-watch") });
    // Lee pauses in the player itself, and it pauses for alex.
    await playerOf(gone).getByRole("button", { name: "Pause" }).click();
    let paused = null;
    for (let i = 0; i < 40 && paused?.state !== 2; i++, await sleep(250)) paused = await fakeOf(again);
    const pausedHere = await fakeOf(gone);
    check("a pause in one person's player pauses everyone's, where it was paused", paused?.state === 2 && pausedHere && Math.abs(paused.time - pausedHere.time) < 0.5 && (await again.locator(".watch-bar").innerText()).includes("Paused by Lee Leaving"));
    // Alex skips ahead, and plays it again, past what the player has loaded: it buffers at the new
    // place first, as YouTube's does, which was once taken for a player catching up and undone.
    await again.frames().find((item) => item.url().startsWith("https://www.youtube-nocookie.com/embed/")).evaluate(() => (window.fake.seekBuffers = true));
    await playerOf(again).getByRole("button", { name: "Ahead 60 s" }).click();
    await sleep(600);
    await playerOf(again).getByRole("button", { name: "Play" }).click();
    let ahead = null;
    for (let i = 0; i < 40 && !(ahead?.state === 1 && ahead.time > 90); i++, await sleep(250)) ahead = await fakeOf(gone);
    check("a seek and a play in one player reach the other", ahead?.state === 1 && ahead.time > 90, `${ahead?.time.toFixed(1)} s, state ${ahead?.state}`);
    // The speed is shared.
    await playerOf(gone).getByRole("combobox", { name: "Speed" }).selectOption("1.5");
    let faster = null;
    for (let i = 0; i < 40 && faster?.rate !== 1.5; i++, await sleep(250)) faster = await fakeOf(again);
    check("a change of speed reaches everyone", faster?.rate === 1.5);
    // Stopping watching here leaves it on for everyone else, and Stop ends it for all.
    await gone.getByRole("button", { name: "Stop watching here" }).click();
    await gone.locator(".watch-cover").waitFor({ timeout: 5_000 });
    const stillOn = await fakeOf(again);
    await again.getByRole("button", { name: "Stop for everyone" }).click();
    await gone.locator(".watch-stage").waitFor({ state: "detached", timeout: 10_000 });
    await again.locator(".watch-stage").waitFor({ state: "detached", timeout: 10_000 });
    check("stopping watching here leaves it on for the others, and Stop ends it for everyone", stillOn?.state === 1 && (await fakeOf(gone)) === null);
    await again.getByRole("button", { name: "Disconnect from voice" }).click();
    await gone.getByRole("button", { name: "Disconnect from voice" }).click();
    await again.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 });

    // They report someone from the bottom of that person's profile, and the admins see whom and why alone.
    await gone.locator(".conv-row", { hasText: "Priya Nair" }).click();
    await gone.locator(".chat-title").click();
    await gone.locator(".side-row", { hasText: "Report Priya Nair" }).click();
    await gone.getByRole("menuitem", { name: "Spam" }).click();
    await gone.locator(".side-row", { hasText: "Reported to the server's admins" }).waitFor({ timeout: 10_000 });
    check("someone is reported from their profile", true);
    await sleep(300);
    await gone.screenshot({ path: prefix("08a-reported") });
    await again.locator(".server-title").click();
    await again.getByRole("menuitem", { name: "Server settings" }).click();
    await again.locator(".settings-nav-item", { hasText: "Reports" }).click();
    const report = again.locator(".device-row", { hasText: "Priya Nair" });
    await report.waitFor({ timeout: 10_000 });
    check("the admins see whom and why", (await report.innerText()).includes("1 report · Spam"), (await report.innerText()).replace(/\n/g, " "));
    await sleep(300);
    await again.screenshot({ path: prefix("08a-reports") });
    // A ban is asked about first, and Escape says no without closing settings.
    await report.getByRole("button", { name: "Ban" }).click();
    const askBan = again.locator(".modal", { hasText: "Ban Priya Nair?" });
    await askBan.waitFor({ timeout: 5_000 });
    await sleep(300);
    await again.screenshot({ path: prefix("08a-ban-confirm") });
    await again.keyboard.press("Escape");
    await askBan.waitFor({ state: "detached", timeout: 5_000 });
    check("a ban asks first, and Escape leaves them be", (await again.locator(".settings-layer").count()) === 1 && (await report.count()) === 1);
    await report.getByRole("button", { name: "Dismiss" }).click();
    await again.getByText("Nobody has been reported.").waitFor({ timeout: 10_000 });
    check("dismissing a report takes it off the list", true);
    // Escape on a member's menu closes the menu alone, and leaves the settings open.
    await again.locator(".settings-nav-item", { hasText: "Members" }).click();
    await again.locator(".device-row.is-button", { hasText: "Priya Nair" }).click();
    const memberMenu = again.locator(".menu").first();
    await memberMenu.waitFor({ timeout: 5_000 });
    await again.keyboard.press("Escape");
    await memberMenu.waitFor({ state: "detached", timeout: 5_000 });
    check("Escape on a member's menu closes only the menu", (await again.locator(".settings-layer").count()) === 1);
    // A ban from Members moves them to Bans, which says by whom and when, and an unban lets them sign in again.
    await again.locator(".device-row.is-button", { hasText: "Lee Leaving" }).click();
    await again.getByRole("menuitem", { name: "Ban from server" }).click();
    await again.locator(".modal").getByRole("button", { name: "Ban from server" }).click();
    leaving.add(gone);
    await gone.getByRole("heading", { name: /^You were removed from/ }).waitFor({ timeout: 20_000 });
    await again.locator(".device-row.is-button", { hasText: "Lee Leaving" }).waitFor({ state: "detached", timeout: 10_000 });
    check("someone banned is signed out and off Members", true);
    await again.locator(".settings-nav-item", { hasText: "Bans" }).click();
    const ban = again.locator(".device-row", { hasText: "Lee Leaving" });
    await ban.waitFor({ timeout: 10_000 });
    check("Bans says whom, by whom and when", (await ban.innerText()).includes("@leaving.check · Banned by you on "), (await ban.innerText()).replace(/\n/g, " "));
    await sleep(300);
    await again.screenshot({ path: prefix("08a-bans") });
    await ban.getByRole("button", { name: "Unban" }).click();
    await again.getByText("Nobody is banned.").waitFor({ timeout: 10_000 });
    await again.locator(".settings-nav-item", { hasText: "Members" }).click();
    await again.locator(".device-row.is-button", { hasText: "Lee Leaving" }).waitFor({ timeout: 10_000 });
    check("an unban takes them off Bans and back onto Members", true);

    // A bot: made in the server's settings, set up by zuna-bot with the link shown once, and then a chat like any other.
    const zunaBot = join(root, "dist", "bot", "zuna-bot.mjs");
    if (!existsSync(zunaBot)) {
      notes.push(`${name}: bots weren't checked, as zuna-bot isn't built (npm run build:bot)`);
      await again.keyboard.press("Escape");
    } else {
      await again.locator(".settings-nav-item", { hasText: "Bots" }).click();
      await again.getByRole("button", { name: "New bot" }).click();
      await fill(again.getByLabel("Name", { exact: true }), "Check Bot");
      await fill(again.getByLabel("Username"), "check.bot");
      await again.getByRole("switch", { name: "List it for everyone" }).click();
      await again.getByRole("button", { name: "Make the bot" }).click();
      const command = await again.locator(".bot-setup .invite-link span").innerText({ timeout: 10_000 });
      const setupLink = /^zuna-bot init "(.+)"$/.exec(command)?.[1] ?? "";
      check("a new bot's setup link is shown, as the command to run", setupLink.includes("#k=") && setupLink.includes("&bot="), command.slice(0, 50));
      await sleep(300);
      await again.screenshot({ path: prefix("08c-bot-link") });
      // zuna-bot, as its owner runs it on the bot's machine, and a call to its API as the bot's code makes one.
      const botData = mkdtempSync(join(tmpdir(), "zuna-web-bot-"));
      execFileSync(process.execPath, [zunaBot, "init", setupLink, "--data", botData], { stdio: "pipe" });
      const botPort = randomPort();
      botProgram = start(process.execPath, [zunaBot, "run", "--data", botData, "--port", String(botPort)]);
      await waitFor(botProgram.output, "API is at", "zuna-bot");
      const botToken = readFileSync(join(botData, "token"), "utf8").trim();
      const botApi = async (method, params = {}) =>
        (await fetch(`http://127.0.0.1:${botPort}/bot${botToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) })).json();
      await again.getByRole("button", { name: "Done" }).click();
      const botEntry = again.locator(".bot-entry", { hasText: "Check Bot" });
      await botEntry.locator(".role-chip", { hasText: "Listed" }).waitFor({ timeout: 30_000 });
      check("the bot is listed once its program has signed up", true);
      await botApi("setMyCommands", { commands: [{ command: "start", description: "Say hello" }] });
      await botEntry.locator(".device-row").click();
      await again.locator(".bot-settings").getByRole("button", { name: "Message" }).click();
      const botHead = again.locator(".chat-head");
      await botHead.locator(".chat-status", { hasText: /^bot$/ }).waitFor({ timeout: 10_000 });
      check("its chat says it's a bot, with its key checked against its link", (await botHead.locator(".bot-badge").count()) === 1 && (await botHead.locator(".conv-verified, [aria-label='Verified']").count()) >= 1);
      // Typing "/" offers its commands, and what it's sent reaches its code.
      await again.locator(".composer-input").click();
      await again.keyboard.type("/");
      const offered = again.locator(".suggestion", { hasText: "/start" });
      await offered.waitFor({ timeout: 10_000 });
      check("typing / offers the bot's commands", (await offered.innerText()).includes("Say hello"));
      await again.keyboard.press("Enter");
      await again.keyboard.press("Enter");
      let heard;
      for (let i = 0; i < 100 && !heard; i++) {
        heard = (await botApi("getUpdates")).result.find((update) => update.message?.text === "/start");
        if (!heard) await sleep(100);
      }
      check("the bot's code gets the command, marked as one", heard?.message.entities?.[0]?.type === "bot_command" && heard.message.from.username === "alex", JSON.stringify(heard?.message ?? null).slice(0, 120));
      // Its answer comes with buttons: one that goes back to it, and one that's a link.
      await botApi("sendMessage", {
        chat_id: heard.message.chat.id,
        text: "<b>Pick</b> one",
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Yes", callback_data: "yes" }, { text: "Docs", url: "https://example.com/docs" }]] },
      });
      const answer = again.locator(".msg", { hasText: "Pick one" });
      await answer.locator(".msg-button").first().waitFor({ timeout: 15_000 });
      const linkButton = answer.locator("a.msg-button");
      check(
        "a bot's message comes with its buttons, a link opening as a link does",
        (await answer.locator(".msg-button").count()) === 2 && (await linkButton.getAttribute("href")) === "https://example.com/docs" && (await linkButton.getAttribute("rel")) === "noreferrer noopener" && (await answer.locator("strong").innerText()) === "Pick",
      );
      await sleep(300);
      await again.screenshot({ path: prefix("08c-bot-chat") });
      const before = await again.locator(".msg").count();
      await answer.locator("button.msg-button", { hasText: "Yes" }).click();
      let pressed;
      for (let i = 0; i < 100 && !pressed; i++) {
        pressed = (await botApi("getUpdates", { offset: heard.update_id + 1 })).result.find((update) => update.callback_query);
        if (!pressed) await sleep(100);
      }
      check("a press goes back to the bot's code, and shows nothing in the chat", pressed?.callback_query.data === "yes" && pressed.callback_query.from.username === "alex" && (await again.locator(".msg").count()) === before);
      // It has a tab of its own in the list, and isn't one of the people.
      await again.getByRole("tab", { name: "People" }).click();
      const amongPeople = await again.locator(".conv-row", { hasText: "Check Bot" }).count();
      await again.getByRole("tab", { name: "Bots" }).click();
      check("bots have a tab of their own, apart from people", amongPeople === 0 && (await again.locator(".conv-row", { hasText: "Check Bot" }).locator(".bot-badge").count()) === 1);
      await again.getByRole("tab", { name: "All" }).click();
      // Deleting it signs its program out, and says so wherever it was.
      await again.locator(".server-title").click();
      await again.getByRole("menuitem", { name: "Server settings" }).click();
      await again.locator(".settings-nav-item", { hasText: "Bots" }).click();
      await again.locator(".bot-entry", { hasText: "Check Bot" }).locator(".device-row").click();
      await again.getByRole("button", { name: "Delete bot" }).click();
      await again.locator(".modal").getByRole("button", { name: "Delete bot" }).click();
      await again.getByText("No bots yet.").waitFor({ timeout: 15_000 });
      await waitFor(botProgram.output, "ended this bot's session", "zuna-bot hearing its bot is gone");
      check("deleting a bot takes it off the list and signs its program out", true);
      await again.keyboard.press("Escape");
      stop(botProgram);
      botProgram = undefined;
      await sleep(200);
      rmSync(botData, { recursive: true, force: true });
    }
    await gone.getByRole("button", { name: "Remove from this device" }).click();
    await gone.getByRole("button", { name: "Sign in", exact: true }).click();
    await fill(gone.getByLabel("Server address"), serverUrl);
    await fill(gone.getByLabel("Username"), "leaving.check");
    await fill(gone.locator('input[type="password"]'), "web-check-only-Pass-5531");
    await gone.getByRole("button", { name: "Sign in", exact: true }).click();
    await gone.locator(".conv-row", { hasText: "Priya Nair" }).waitFor({ timeout: 45_000 });
    check("someone unbanned signs in again", true);

    await gone.getByLabel("Settings", { exact: true }).click();
    await gone.getByRole("button", { name: "Delete account" }).click();
    await gone.getByRole("button", { name: "Delete my account" }).waitFor({ timeout: 10_000 });
    await fill(gone.getByLabel("Password", { exact: true }), "web-check-only-Pass-5531");
    await sleep(300);
    await gone.screenshot({ path: prefix("08b-delete-account") });
    leaving.add(gone);
    await gone.getByRole("button", { name: "Delete my account" }).click();
    await gone.locator(".modal").getByRole("button", { name: "Delete account" }).click();
    await gone.getByRole("button", { name: "Join with an invite" }).waitFor({ timeout: 20_000 });
    check("deleting an account leaves the app with no server", true);
    await again.locator(".conv-row", { hasText: "Lee Leaving" }).waitFor({ state: "detached", timeout: 20_000 });
    check("a deleted account leaves everyone's list", true);

    // Where the browser keeps nothing, the app says why it can't run
    if (name === "webkit") {
      const privateBrowser = await webkit.launch();
      const privatePage = await (await privateBrowser.newContext()).newPage();
      await privatePage.goto(appUrl);
      await privatePage.getByText("which happens in private windows").waitFor({ timeout: 15_000 }).catch(() => undefined);
      check("a private window says why Zuna can't run there", await privatePage.getByText("which happens in private windows").isVisible());
      await privatePage.screenshot({ path: prefix("09-private-window") });
      await privateBrowser.close();
    }

    check("no errors in the page", errors.length === 0, errors.slice(0, 5).join(" | "));
    const kept = liveKitLogProblems(liveKit.output());
    check("LiveKit's log keeps nothing of who joined, from where or on what", kept.length === 0, kept.slice(0, 5).join(" | "));
    if (cutOffs) notes.push(`${name}: ${cutOffs} request(s) cut off as the check reloaded, handed over or closed a tab`);
  } catch (error) {
    check("the run finished", false, error.message.split("\n")[0]);
    console.error(error);
    for (const [index, open] of [...(context?.pages() ?? []), ...(fresh?.pages() ?? []), ...(elsewhere?.pages() ?? []), ...(leaver?.pages() ?? [])].entries()) {
      await open.screenshot({ path: prefix(`crash-${index}`) }).catch(() => undefined);
    }
    if (errors.length) console.error("Page errors:", errors);
  } finally {
    await context?.close().catch(() => undefined);
    await fresh?.close().catch(() => undefined);
    await elsewhere?.close().catch(() => undefined);
    await leaver?.close().catch(() => undefined);
    stop(bots);
    stop(botProgram);
    stop(web);
    stop(server);
    stop(liveKit);
    await sleep(300);
    rmSync(data, { recursive: true, force: true });
  }
}

try {
  for (const name of chosen.length ? chosen : ["chromium", "firefox", "webkit"]) await runIn(name);
} finally {
  site.close();
  rmSync(bin, { recursive: true, force: true });
}
if (notes.length) console.log(`\n${notes.join("\n")}`);
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nALL WEB CHECKS PASSED");
console.log(`Screenshots: ${shots}`);
process.exitCode = failures.length ? 1 : 0;
