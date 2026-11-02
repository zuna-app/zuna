// Drives the built web app in Chromium, Firefox and WebKit, served by a real
// zuna-web, against a real server and live bots. It checks what only the web app
// does, and that the shared interface works in each browser, and saves
// screenshots to look over.
//
//   npm run build -w @zuna/web && node apps/web/test/web-check.mjs [screenshot-dir] [chromium] [firefox] [webkit]
//
// Needs Playwright's browsers: npx playwright-core install chromium firefox webkit
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, firefox, webkit } from "playwright-core";
import { ensureLiveKit } from "../../../scripts/lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const engines = { chromium, firefox, webkit };
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
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", join(bin, name + exe), `./cmd/${name}`], { cwd: join(root, "server"), env: goEnv, stdio: "inherit" });
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
    // Bots run under npx, so the whole group goes.
    if (process.platform !== "win32" && process_.child.spawnargs[0] === "npx") process.kill(-process_.child.pid);
    else if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(process_.child.pid), "/T", "/F"], { stdio: "ignore" });
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
  if (name === "firefox") return { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } };
  return {};
}

async function signUp(page, link, serverName) {
  await page.getByLabel("Invite link").fill(link, { timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Alex Rivera", { timeout: 15_000 });
  await page.getByLabel("Username").fill("alex");
  await page.locator('input[type="password"]').fill("web-check-only-Pass-9182");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Our corner of the internet").fill(serverName);
  await page.getByRole("button", { name: "Finish" }).click();
  await page.locator(".conv-row").first().waitFor({ timeout: 20_000 });
}

/** The unread count the title should show: every badge, apart from muted chats. */
const unreadInList = (page) =>
  page.evaluate(() => [...document.querySelectorAll(".conv-badge:not(.is-muted)")].reduce((sum, badge) => sum + Number(badge.textContent.replace("+", "")), 0));

async function runIn(name) {
  engine = name;
  const prefix = (shot) => join(shots, `${name}-${shot}.png`);
  const data = mkdtempSync(join(tmpdir(), "zuna-web-data-"));
  const serverPort = randomPort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  const liveKitPort = randomPort();
  const liveKit = start(ensureLiveKit(), ["--dev", "--bind", lanAddress, "--bind", "127.0.0.1", "--node-ip", lanAddress, "--port", String(liveKitPort)]);
  const server = start(join(bin, `zuna-server${exe}`), ["--listen", `127.0.0.1:${serverPort}`, "--data", data, "--public-url", serverUrl, "--auth-burst", "1000", "--push-relays", "off", "--livekit-internal-url", `http://127.0.0.1:${liveKitPort}`, "--livekit-key", "devkey", "--livekit-secret", "secret"]);
  const webPort = randomPort();
  const web = start(join(bin, `zuna-web${exe}`), ["--listen", `127.0.0.1:${webPort}`, "--root", dist, "--dev"]);
  const appUrl = `http://localhost:${webPort}/`;
  let context;
  let fresh;
  let bots;
  const errors = [];
  try {
    await waitFor(server.output, "/invite/", "the server");
    const link = server.output().match(/http:\/\/\S+\/invite\/\S+/)[0];
    await waitFor(web.output, "Listening on", "zuna-web");

    // A browser's own profile, as people use: Safari keeps no files for a private window.
    const profile = () => engines[name].launchPersistentContext(mkdtempSync(join(tmpdir(), `zuna-web-${name}-`)), { ...launchOptions(name), viewport: { width: 1280, height: 800 } });
    context = await profile();
    if (name !== "firefox") await context.grantPermissions(["microphone"], { origin: appUrl.slice(0, -1) }).catch(() => undefined);
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
    const page = context.pages()[0] ?? (await context.newPage());
    watch(page, "first tab");

    // Starting, and what the host sends
    const response = await page.goto(appUrl);
    const headers = response.headers();
    check("the page comes with the content security policy", (headers["content-security-policy"] ?? "").includes("script-src 'self' 'wasm-unsafe-eval'"));
    await page.getByLabel("Invite link").waitFor({ timeout: 30_000 });
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
    bots = start("npx", ["vite-node", "test/dev-bots.ts", invite], { cwd: join(root, "packages", "core"), detached: process.platform !== "win32", shell: process.platform === "win32" });
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

    // Voice messages: what each browser can record, and whether an iPhone could play it
    const formats = await page.evaluate(() =>
      ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus"].filter((type) => window.MediaRecorder?.isTypeSupported(type)),
    );
    notes.push(`${name} records: ${formats.join(", ") || "nothing"}`);
    try {
      await page.getByLabel("Record a voice message").click();
      await page.locator(".recording-row").waitFor({ timeout: 10_000 });
      await sleep(1500);
      await page.getByLabel("Send voice message").click();
      const voice = page.locator(".msg.is-own .voice").last();
      await voice.locator(".voice-play[aria-label='Play voice message']").waitFor({ timeout: 15_000 });
      check("a voice message is recorded and sent", true, await voice.locator(".voice-time").innerText());
    } catch (error) {
      check("a voice message is recorded and sent", false, error.message.split("\n")[0]);
    }
    const recorded = await page
      .evaluate(async () => {
        const types = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus"];
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream, { mimeType: types.find((type) => MediaRecorder.isTypeSupported(type)) });
        const chunks = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const done = new Promise((resolve) => (recorder.onstop = resolve));
        recorder.start(250);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        recorder.stop();
        await done;
        stream.getTracks().forEach((track) => track.stop());
        const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { type: recorder.mimeType, data: btoa(binary) };
      })
      .catch((error) => ({ type: "", data: "", error: error.message }));
    if (process.platform === "darwin" && recorded.data) {
      const file = join(shots, `${name}-voice.m4a`);
      writeFileSync(file, Buffer.from(recorded.data, "base64"));
      let info = "";
      try {
        info = execFileSync("afinfo", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        // Apple's decoder can't read it.
      }
      check("an iPhone could play what this browser records (AAC in MP4)", /aac/i.test(info), `${recorded.type}${info ? `, ${info.match(/Data format:.*/)?.[0]}` : ", unreadable to Apple's decoder"}`);
    } else if (recorded.error) {
      notes.push(`${name} couldn't record: ${recorded.error}`);
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
    check("there are no notification switches", (await second.getByText("Desktop notifications").count()) === 0 && (await second.getByText("Away from the computer after").count()) === 1);
    await second.getByText("Security", { exact: true }).first().click();
    check("Security warns that the browser can't protect the key", (await second.getByText("Browsers can't lock Zuna's local data").count()) === 1);
    const deviceName = await second.locator(".device-row", { hasText: "This device" }).innerText();
    check("this browser is named in Devices", /(Chrome|Firefox|Safari|Edge|Browser) on \w+/.test(deviceName), deviceName.split("\n")[0]);
    await second.screenshot({ path: prefix("06-security") });
    await second.keyboard.press("Escape");

    // A browser whose data was cleared signs in again, and the history comes back from the vault.
    // Playwright's WebKit profiles share the origin-private file system, so this one also
    // finds a database it has no key for, which it has to clear rather than fail on.
    leaving.add(second);
    await context.close();
    context = undefined;
    fresh = await profile();
    const again = fresh.pages()[0] ?? (await fresh.newPage());
    watch(again, "fresh browser");
    await again.goto(appUrl);
    await again.getByRole("button", { name: "I already have an account" }).click();
    await again.getByLabel("Server address").fill(serverUrl);
    await again.getByLabel("Username").fill("alex");
    await again.locator('input[type="password"]').fill("web-check-only-Pass-9182");
    await again.getByRole("button", { name: "Sign in", exact: true }).click();
    await again.locator(".conv-row", { hasText: "Priya" }).waitFor({ timeout: 45_000 });
    await again.locator(".conv-row", { hasText: "Priya" }).click();
    await again.locator(".msg.is-own", { hasText: "This is the spot" }).waitFor({ timeout: 45_000 });
    check("signing in again brings the history back", true);
    await again.screenshot({ path: prefix("07-signed-in-again") });

    // Channels and voice, under this host's content security policy
    again.on("console", (message) => message.text().includes("[zuna]") && console.log(`  ${message.text()}`));
    await again.locator(".channel-empty button").click();
    await again.getByPlaceholder("new-channel").fill("general");
    await again.getByRole("button", { name: "Create channel" }).click();
    await again.locator(".chat-title", { hasText: "general" }).waitFor({ timeout: 15_000 });
    await again.locator(".composer-input").fill("hello channel");
    await again.keyboard.press("Enter");
    await again.locator(".bubble", { hasText: "hello channel" }).waitFor({ timeout: 15_000 });
    check("a text channel works", true);
    await again.locator(".channel-section-head", { hasText: "Text channels" }).hover();
    await again.getByRole("button", { name: /New channel in Text channels/ }).click();
    await again.getByRole("button", { name: /^Voice/ }).click();
    await again.getByPlaceholder("Lounge").fill("Lounge");
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
    await again.getByRole("button", { name: "Disconnect from voice" }).click();
    await again.locator(".voice-panel").waitFor({ state: "detached", timeout: 10_000 });

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
    if (cutOffs) notes.push(`${name}: ${cutOffs} request(s) cut off as the check reloaded, handed over or closed a tab`);
  } catch (error) {
    check("the run finished", false, error.message.split("\n")[0]);
    console.error(error);
    for (const [index, open] of [...(context?.pages() ?? []), ...(fresh?.pages() ?? [])].entries()) {
      await open.screenshot({ path: prefix(`crash-${index}`) }).catch(() => undefined);
    }
    if (errors.length) console.error("Page errors:", errors);
  } finally {
    await context?.close().catch(() => undefined);
    await fresh?.close().catch(() => undefined);
    stop(bots);
    stop(web);
    stop(server);
    stop(liveKit);
    await sleep(300);
    rmSync(data, { recursive: true, force: true });
  }
}

try {
  for (const name of chosen.length ? chosen : Object.keys(engines)) await runIn(name);
} finally {
  site.close();
  rmSync(bin, { recursive: true, force: true });
}
if (notes.length) console.log(`\n${notes.join("\n")}`);
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nALL WEB CHECKS PASSED");
console.log(`Screenshots: ${shots}`);
process.exitCode = failures.length ? 1 : 0;
