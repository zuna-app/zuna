// Drives the real Electron app against a real server and live bots, checks how
// the interface behaves, and saves screenshots to look over.
//
//   npm run build -w @zuna/desktop && node apps/desktop/test/ui-check.mjs [screenshot-dir]

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-ui-"));
mkdirSync(shots, { recursive: true });

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const binary = join(tmpdir(), `zuna-ui-server${process.platform === "win32" ? ".exe" : ""}`);
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], {
  cwd: join(root, "server"),
  env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
  stdio: "inherit",
});

const data = mkdtempSync(join(tmpdir(), "zuna-ui-data-"));
const userData = mkdtempSync(join(tmpdir(), "zuna-ui-user-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const url = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--listen", `127.0.0.1:${port}`, "--data", data, "--public-url", url, "--auth-burst", "1000"], { stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function setupLink(output = () => serverOutput) {
  for (let i = 0; i < 200; i++) {
    const match = output().match(/http:\/\/\S+\/invite\/\S+/);
    if (match) return match[0];
    await sleep(50);
  }
  throw new Error(`the server didn't start:\n${output()}`);
}

const failures = [];
const errors = [];
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

let electronApp;
let bots;
let secondServer;
const secondData = mkdtempSync(join(tmpdir(), "zuna-ui-data-"));
try {
  const link = await setupLink();
  electronApp = await electron.launch({
    // Chromium's fake microphone plays a tone, for voice messages.
    args: [app, `--user-data-dir=${userData}`, "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => errors.push(`${error.message} ${error.stack?.split("\n")[1]?.trim() ?? ""}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("WebSocket")) errors.push(`${message.text()} (${message.location().url.split("/").pop()}:${message.location().lineNumber})`);
  });
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1280, 832);
    window.center();
  });
  const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
  const activeClass = () => page.evaluate(() => document.activeElement?.className ?? "");
  const composerFocused = async () => (await activeClass()).includes("composer-input");
  const openChat = async (name) => {
    await page.locator(".conv-row").filter({ has: page.locator(".conv-title", { hasText: name }) }).first().click();
    await page.locator(".chat-title", { hasText: name }).waitFor();
    // The list finds its place just before the chat's first frame is painted. A click
    // aimed before then lands on whatever has moved there, and Playwright's retry
    // scrolls the message into view, as if someone had scrolled up to it.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };

  // Onboarding
  await page.getByRole("button", { name: "Join with an invite" }).waitFor({ timeout: 30_000 });
  await sleep(200);
  await shot("01-welcome");
  await page.getByRole("button", { name: "Join with an invite" }).click();
  await page.getByLabel("Invite link").fill(link);
  await sleep(200);
  await shot("01-invite-link");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Alex Rivera", { timeout: 15_000 });
  await page.locator('input[type="password"]').fill("ui-check-only-Pass-9182");
  await sleep(200);
  await shot("02-signup");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await sleep(200);
  await shot("03-recovery");
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Our corner of the internet").fill("Friends");
  await page.getByRole("button", { name: "Finish" }).click();
  await page.locator(".conv-row").first().waitFor({ timeout: 20_000 });

  // People to talk to
  await page.locator(".server-title").click();
  await page.getByRole("menuitem", { name: "Invite people" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const invite = await page.locator(".invite-link span").first().textContent({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  bots = spawn("npx", ["vite-node", "test/dev-bots.ts", invite], { cwd: join(root, "packages", "core"), shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let botOutput = "";
  bots.stdout.on("data", (chunk) => (botOutput += chunk));
  bots.stderr.on("data", (chunk) => (botOutput += chunk));
  for (let i = 0; i < 240 && !botOutput.includes("Bots are ready"); i++) await sleep(250);
  if (!botOutput.includes("Bots are ready")) throw new Error(`the bots didn't start:\n${botOutput}`);
  await page.locator(".conv-row", { hasText: "Weekend trip" }).waitFor();
  await sleep(1500);
  await shot("04-list");

  // Switching chats is instant
  const switchMs = await page.evaluate(async () => {
    const row = [...document.querySelectorAll(".conv-row")].find((item) => item.textContent.includes("Weekend trip"));
    const start = performance.now();
    row.click();
    await new Promise((resolve) => {
      const poll = () => {
        if (document.querySelector(".chat-title")?.textContent.includes("Weekend trip") && document.querySelector(".bubble")) resolve();
        else requestAnimationFrame(poll);
      };
      poll();
    });
    return Math.round(performance.now() - start);
  });
  check("first open of a chat shows messages quickly", switchMs < 400, `${switchMs} ms`);
  await sleep(500);
  await shot("05-group");

  const backMs = await page.evaluate(async () => {
    const pick = (name) => [...document.querySelectorAll(".conv-row")].find((item) => item.textContent.includes(name));
    pick("Priya").click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const start = performance.now();
    pick("Weekend trip").click();
    await new Promise((resolve) => {
      const poll = () => {
        if (document.querySelector(".chat-title")?.textContent.includes("Weekend trip") && document.querySelector(".bubble")) resolve();
        else requestAnimationFrame(poll);
      };
      poll();
    });
    return Math.round(performance.now() - start);
  });
  check("returning to a chat is immediate", backMs < 120, `${backMs} ms`);

  // Message layout
  const gap = await page.evaluate(() => {
    const bubble = document.querySelector(".msg.is-other .bubble:has(.msg-text)");
    const meta = bubble.querySelector(".msg-meta");
    const a = bubble.getBoundingClientRect();
    const b = meta.getBoundingClientRect();
    return { right: Math.round(a.right - b.right), bottom: Math.round(a.bottom - b.bottom) };
  });
  check("the time keeps its distance from the bubble's edge", gap.right >= 10 && gap.bottom >= 5, `right ${gap.right}px, bottom ${gap.bottom}px`);

  const paintedGradients = await page.evaluate(() =>
    [...document.querySelectorAll("*")].filter((element) => getComputedStyle(element).backgroundImage.includes("gradient")).length,
  );
  check("nothing on screen uses a gradient", paintedGradients === 0, `${paintedGradients} elements`);

  // Sticky focus
  await sleep(200);
  check("the message box is focused after opening a chat", await composerFocused());
  await page.locator(".bubble").first().click({ position: { x: 4, y: 4 } });
  await sleep(50);
  check("clicking a message returns focus to the message box", await composerFocused());
  await page.locator(".chat-title").click();
  await sleep(150);
  check("opening the details panel keeps focus in the message box", await composerFocused());
  await page.keyboard.press("Escape");
  await sleep(100);
  check("Escape in the message box closes the panel", (await page.locator(".side-panel").count()) === 0);

  // Verifying someone
  await page.locator(".conv-row", { hasText: "Priya" }).first().click();
  await page.locator(".chat-title", { hasText: "Priya" }).waitFor({ timeout: 10_000 });
  await page.locator(".chat-title").click();
  await page.locator(".trust-card.trust-unverified").click();
  await page.locator(".safety-cell").first().waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "They match" }).click();
  await page.locator(".trust-card.trust-verified").waitFor({ timeout: 10_000 });
  await page.locator(".safety-cell").first().waitFor({ state: "detached", timeout: 10_000 });
  check("saying the emoji match verifies someone", true);
  await page.locator(".trust-card.trust-verified").click();
  await page.getByRole("button", { name: "Remove verification" }).click();
  await page.locator(".trust-card.trust-unverified").waitFor({ timeout: 10_000 });
  check("verification can be removed", true);
  await page.keyboard.press("Escape");
  await sleep(100);
  await page.locator(".composer-input").click();
  await page.keyboard.press("Escape");
  await sleep(100);
  check("the panel closes again after verifying", (await page.locator(".side-panel").count()) === 0);
  await page.locator(".conv-row", { hasText: "Weekend trip" }).click();
  await page.locator(".chat-title", { hasText: "Weekend trip" }).waitFor({ timeout: 10_000 });
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.type("h");
  check("typing anywhere goes into the message box", (await page.locator(".composer-input").inputValue()) === "h");
  await page.locator(".composer-input").fill("");
  await page.evaluate(() => {
    document.activeElement.blur();
    window.dispatchEvent(new Event("focus"));
  });
  await sleep(50);
  check("coming back to the window returns focus to the message box", await composerFocused());

  // Reactions
  await page.locator(".reaction").first().waitFor({ timeout: 10_000 });
  const inside = await page.evaluate(() => !!document.querySelector(".bubble .reactions .reaction"));
  check("reactions sit inside the bubble", inside);
  await page.locator(".msg", { hasText: "Works for me" }).first().click({ button: "right" });
  await page.locator(".menu-react button").nth(1).click();
  await page.locator(".msg", { hasText: "Works for me" }).locator(".reaction.is-mine").waitFor({ timeout: 10_000 });
  check("reacting from the menu shows your reaction", true);
  await sleep(100);
  check("focus returns after using a menu", await composerFocused());
  await sleep(300);
  await shot("06-reactions");

  // Sending, with a live reply
  await openChat("Priya");
  await page.keyboard.type("Checking now. **Looks** fine, `port: 8787` is right");
  await page.keyboard.press("Enter");
  await page.locator(".msg.is-own .msg-text", { hasText: "Checking now" }).waitFor({ timeout: 10_000 });
  check("sending keeps focus in the message box", await composerFocused());
  await page.locator(".msg.is-other", { hasText: "You said" }).waitFor({ timeout: 15_000 });
  await sleep(300);
  await shot("07-dm");

  // Photos and files
  const pngBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 560;
    const context = canvas.getContext("2d");
    context.fillStyle = "#3a4a55";
    context.fillRect(0, 0, 900, 560);
    context.fillStyle = "#c9d3da";
    context.fillRect(0, 380, 900, 180);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[type="file"]').setInputFiles([{ name: "lake.png", mimeType: "image/png", buffer: Buffer.from(pngBase64, "base64") }]);
  await page.locator(".file-chip").waitFor();
  await page.keyboard.press("Enter");
  await page.locator(".media-full").last().waitFor({ timeout: 15_000 });
  await page.locator('input[type="file"]').setInputFiles([{ name: "packing-list.txt", mimeType: "text/plain", buffer: Buffer.from("tent\nspeaker\n") }]);
  await page.locator(".file-chip").waitFor();
  await page.keyboard.type("Here is the list");
  await page.keyboard.press("Enter");
  await page.locator(".file-card").last().waitFor({ timeout: 15_000 });
  // A second and a half of a moving square, recorded here.
  const webmBase64 = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
    const parts = [];
    recorder.ondataavailable = (event) => parts.push(event.data);
    const stopped = new Promise((resolve) => (recorder.onstop = resolve));
    recorder.start();
    for (let frame = 0; frame < 45; frame++) {
      context.fillStyle = "#2f6f5e";
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#f2c14e";
      context.fillRect(frame * 10, 120, 120, 120);
      await new Promise((resolve) => setTimeout(resolve, 33));
    }
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  await page.locator('input[type="file"]').setInputFiles([{ name: "square.webm", mimeType: "video/webm", buffer: Buffer.from(webmBase64, "base64") }]);
  await page.locator(".file-chip").waitFor();
  await page.keyboard.press("Enter");
  await page.locator("video.media-video").last().waitFor({ timeout: 15_000 });
  await sleep(500);
  check("the message box stays focused while sending files", await composerFocused());
  await shot("07b-media");

  // Emote hover cards
  await openChat("Sam");
  await sleep(900);
  await page.locator(".emote-jumbo").first().hover();
  await page.locator(".emote-card").waitFor({ timeout: 3000 });
  const card = await page.locator(".emote-card").innerText();
  check("hovering an emote shows its name and creator", /by .+/.test(card), card.replace(/\n/g, " / "));
  await shot("08-emote-hover");
  await page.mouse.move(10, 10);

  // Emote picker
  await page.getByLabel("Emoji and emotes").click();
  await page.locator(".picker").waitFor();
  await sleep(700);
  await page.locator(".emote-cell").nth(5).hover();
  await sleep(100);
  const footer = await page.locator(".picker-footer").innerText();
  check("the picker shows who made the hovered emote", /by .+/.test(footer), footer.replace(/\n/g, " "));
  await shot("09-picker");
  await page.keyboard.press("Escape");
  await sleep(150);
  check("focus returns after closing the picker", await composerFocused());

  // Emotes are offered from the ":" on, and until two letters are typed only the
  // arrows or Tab pick one, so ":D" and Enter still sends ":D".
  const composer = page.locator(".composer-input");
  await page.keyboard.type(":");
  await page.locator(".suggestion").first().waitFor({ timeout: 3000 });
  const offered = await page.locator(".suggestion").count();
  const pickedAtFirst = await page.locator(".suggestion.is-selected").count();
  await shot("09b-emote-suggestions");
  await page.keyboard.press("ArrowDown");
  const first = (await page.locator(".suggestion.is-selected .truncate").first().textContent()) ?? "";
  await page.keyboard.press("Enter");
  check("typing \":\" offers emotes, and the arrows pick one", offered > 0 && pickedAtFirst === 0 && !!first && (await composer.inputValue()) === `${first} `, `${offered} offered, ${pickedAtFirst} picked at first, "${await composer.inputValue()}"`);
  await composer.fill("");
  await page.keyboard.type(":D");
  await sleep(150);
  await page.keyboard.press("Enter");
  await page.locator(".msg.is-own .msg-text", { hasText: ":D" }).last().waitFor({ timeout: 5000 }).then(() => check("\":D\" and Enter still sends \":D\"", true)).catch(() => check("\":D\" and Enter still sends \":D\"", false));

  // Code
  await openChat("Jordan");
  await page.locator(".code-block").waitFor();
  await sleep(800);
  await shot("10-code");

  // Details panel and dialogs
  await openChat("Weekend trip");
  await page.locator(".chat-title").click();
  await sleep(250);
  await shot("11-group-details");

  // A chat's photos, files and links, from its details
  const groupRows = await page.locator(".side-panel .side-row.is-button").allInnerTexts();
  check("a group's details count its photos, files and links", ["2 photos", "1 file", "1 shared link"].every((row) => groupRows.includes(row)), groupRows.join(", "));
  await page.locator(".side-row", { hasText: "2 photos" }).click();
  await page.locator(".shared-tile-full").nth(1).waitFor({ timeout: 15_000 });
  check("its photos open as a grid", (await page.locator(".shared-tile").count()) === 2);
  await sleep(150);
  await shot("11b-group-photos");
  await page.locator(".shared-tile").first().click();
  await page.locator(".image-viewer").waitFor();
  await page.keyboard.press("Escape");
  await page.getByLabel("Back to details").click();
  await page.locator(".side-row", { hasText: "1 shared link" }).click();
  await page.locator(".shared-link-url", { hasText: "example.com/weather" }).waitFor();
  await sleep(150);
  await shot("11c-group-links");
  await page.locator(".shared-link").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Show in chat" }).click();
  await page.locator(".msg.is-highlighted", { hasText: "The forecast" }).waitFor({ timeout: 5000 });
  check("a shared link shows its message in the chat", true);
  await page.keyboard.press("Escape");

  await openChat("Priya");
  await page.locator(".chat-title").click();
  await page.locator(".side-row", { hasText: "1 photo" }).waitFor();
  const personRows = await page.locator(".side-panel .side-row.is-button").allInnerTexts();
  check("a person's details count what was sent and the groups in common", ["1 photo", "1 video", "1 file", "1 group in common"].every((row) => personRows.includes(row)), personRows.join(", "));
  await page.locator(".side-row", { hasText: "1 video" }).click();
  await page.locator(".shared-tile-full").waitFor({ timeout: 15_000 });
  await sleep(150);
  const videoTile = await page.locator(".shared-tile").evaluate((tile) => ({
    frame: tile.querySelector(".shared-tile-full")?.naturalWidth ?? 0,
    poster: tile.querySelector(".shared-tile-thumb") ? getComputedStyle(tile.querySelector(".shared-tile-thumb")).filter : "none",
  }));
  check("a video's tile shows a frame from it, with its picture sharp", videoTile.frame > 0 && videoTile.poster === "none", JSON.stringify(videoTile));
  await shot("11d-person-videos");
  await page.getByLabel("Back to details").click();
  await page.locator(".side-row", { hasText: "1 file" }).click();
  await page.locator(".shared-item .file-card", { hasText: "packing-list.txt" }).waitFor();
  await sleep(150);
  await shot("11d-person-files");
  await page.getByLabel("Back to details").click();
  await page.getByText("Not verified yet").click();
  await sleep(250);
  await shot("12-verify");
  await page.keyboard.press("Escape");
  await sleep(150);
  check("focus returns after closing a dialog", await composerFocused());
  await page.keyboard.press("Escape");

  await page.getByLabel("Settings", { exact: true }).click();
  await sleep(150);
  await shot("13-settings");
  // Removing metadata from files is on, and turning it off asks first.
  await page.locator(".settings-nav-item", { hasText: "Privacy" }).click();
  const metadataSwitch = page.getByRole("switch", { name: "Remove metadata from files" });
  check("metadata is removed from files by default", (await metadataSwitch.getAttribute("aria-checked")) === "true");
  await metadataSwitch.click();
  await page.locator(".modal", { hasText: "Send files with their metadata?" }).waitFor();
  await sleep(150);
  await shot("13b-keep-metadata");
  await page.keyboard.press("Escape");
  await sleep(150);
  check(
    "Escape closes the question, not settings, and leaves metadata removed",
    (await page.getByRole("dialog").count()) === 0 && (await page.locator(".settings-layer").count()) === 1 && (await metadataSwitch.getAttribute("aria-checked")) === "true",
  );
  await metadataSwitch.click();
  await page.getByRole("button", { name: "Turn off" }).click();
  check("turning it off takes a yes", (await metadataSwitch.getAttribute("aria-checked")) === "false");
  await metadataSwitch.click();
  check("turning it back on doesn't ask", (await page.getByRole("dialog").count()) === 0 && (await metadataSwitch.getAttribute("aria-checked")) === "true");
  await page.getByText("Appearance", { exact: true }).click();
  await sleep(100);
  await shot("14-appearance");
  await page.locator(".settings-nav-item", { hasText: "Screen sharing" }).click();
  await sleep(100);
  await shot("14b-screen-sharing");
  await page.keyboard.press("Escape");
  await sleep(150);
  check("focus returns after closing settings", await composerFocused());

  await page.locator(".server-title").click();
  await page.getByRole("menuitem", { name: "Server settings" }).click();
  await page.locator(".settings-nav-item", { hasText: "Emotes" }).click();
  await sleep(300);
  await shot("15-server-emotes");
  await page.locator(".settings-nav-item", { hasText: "Members" }).click();
  await sleep(200);
  await shot("16-server-members");
  await page.locator(".settings-nav-item", { hasText: "Screen sharing" }).click();
  await sleep(200);
  await shot("16b-server-screen-sharing");
  await page.keyboard.press("Escape");
  await sleep(150);

  // Message actions
  await openChat("Weekend trip");
  await page.locator(".msg", { hasText: "Perfect. Booking" }).first().click({ button: "right" });
  await sleep(150);
  await shot("17-message-menu");
  await page.getByRole("menuitem", { name: "Reply" }).click();
  await sleep(150);
  check("replying keeps focus in the message box", await composerFocused());
  const newestHidden = () =>
    page.evaluate(() => {
      const bubbles = [...document.querySelectorAll(".msg .bubble")];
      const last = bubbles[bubbles.length - 1].getBoundingClientRect();
      return Math.round(last.bottom - document.querySelector(".message-list").getBoundingClientRect().bottom);
    });
  const hiddenWhileReplying = await newestHidden();
  check("the newest message stays visible while replying", hiddenWhileReplying <= 0, `${hiddenWhileReplying}px below the list`);
  await shot("18-replying");
  await page.keyboard.press("Escape");
  await sleep(150);
  const hiddenAfterReplying = await newestHidden();
  check("the newest message stays in place after replying", hiddenAfterReplying <= 0 && hiddenAfterReplying > -40, `${hiddenAfterReplying}px from the list's end`);
  await page.locator(".msg", { hasText: "Works for me" }).first().locator(".msg-text").dblclick();
  await page.locator(".composer-context", { hasText: "Replying to Priya" }).waitFor({ timeout: 5000 });
  check("a double click on a message replies to it", await composerFocused());
  check("a double click replies rather than selecting a word", await page.evaluate(() => !window.getSelection()?.toString()));
  await page.keyboard.press("Escape");
  await sleep(150);
  await openChat("Priya");
  await page.locator(".msg.is-own", { hasText: "Checking now" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await sleep(150);
  check("editing keeps focus in the message box", await composerFocused());
  await shot("19-editing");
  await page.keyboard.press("Escape");
  await page.locator(".media-full").last().click();
  await sleep(250);
  await shot("20-image-viewer");
  await page.keyboard.press("Escape");
  await sleep(150);
  check("focus returns after closing the image viewer", await composerFocused());

  // Link previews, fetched by this device through the main process
  const siteHits = [];
  const site = createServer((request, response) => {
    siteHits.push(request.url);
    if (request.url === "/lake.png") {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from(pngBase64, "base64"));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "tracker=1" });
    response.end(`<html><head><meta property="og:site_name" content="Lake Guide"><meta property="og:title" content="The quiet side of the lake">
      <meta property="og:description" content="Where to camp, swim and watch the sunset, away from the crowds."><meta property="og:image" content="/lake.png"></head></html>`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const article = `http://127.0.0.1:${site.address().port}/guide`;
  await page.keyboard.type(`This is the spot ${article}`);
  await page.locator(".link-draft", { hasText: "The quiet side of the lake" }).waitFor({ timeout: 10_000 });
  check("writing a link shows its preview", siteHits.includes("/lake.png"), siteHits.join(", "));
  await shot("19b-link-draft");
  await page.keyboard.press("Enter");
  const linkCard = page.locator(".msg.is-own .link-card", { hasText: "The quiet side of the lake" });
  await linkCard.waitFor({ timeout: 10_000 });
  check("the sent message shows the link's preview with its picture", (await linkCard.locator(".link-card-image").count()) === 1);
  check("the message box is ready for the next message", (await page.locator(".link-draft").count()) === 0 && (await composerFocused()));
  site.close();
  await sleep(300);
  await shot("19c-link-preview");

  // Forwarding
  await page.locator(".msg.is-other", { hasText: "You said" }).last().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Forward" }).click();
  await page.locator(".forward-list").waitFor();
  await page.getByLabel("Search chats").fill("week");
  await sleep(150);
  await shot("19d-forward");
  await page.locator(".forward-list .person-row", { hasText: "Weekend trip" }).click();
  await page.locator(".chat-title", { hasText: "Weekend trip" }).waitFor();
  const forwarded = page.locator(".msg.is-own", { hasText: "You said" }).last();
  await forwarded.locator(".msg-forwarded", { hasText: "Forwarded from Priya" }).waitFor({ timeout: 10_000 });
  check("a forwarded message opens its chat and names its author", true);
  await sleep(300);
  await shot("19e-forwarded");

  // Voice messages
  await page.getByLabel("Record a voice message").click();
  await page.locator(".recording-row").waitFor();
  await sleep(1800);
  check("recording shows the time and the microphone's level", (await page.locator(".recording-levels i").count()) > 10);
  await shot("19f-recording");
  await page.getByLabel("Send voice message").click();
  const voice = page.locator(".msg.is-own .voice").last();
  await voice.locator(".voice-play[aria-label='Play voice message']").waitFor({ timeout: 15_000 });
  check("a voice message shows its length", /^0:0[1-3]$/.test(await voice.locator(".voice-time").innerText()), await voice.locator(".voice-time").innerText());
  await voice.locator(".voice-play").click();
  await voice.locator(".voice-play[aria-label='Pause']").waitFor({ timeout: 10_000 });
  await voice.locator(".voice-wave i.is-played").first().waitFor({ timeout: 5000 });
  check("a voice message plays, filling its waveform", true);
  await shot("19g-voice");
  await voice.locator(".voice-play").click();
  await page.getByLabel("Details", { exact: true }).click();
  await page.locator(".side-row", { hasText: "1 voice message" }).click();
  const listedVoice = page.locator(".shared-item .voice");
  await listedVoice.locator(".voice-play").click();
  await listedVoice.locator(".voice-play[aria-label='Pause']").waitFor({ timeout: 10_000 });
  check("a voice message plays from the chat's details", true);
  await shot("19g2-voice-in-details");
  await listedVoice.locator(".voice-play").click();
  await page.locator(".side-head").getByLabel("Close").click();

  // The desktop records AAC in MP4, which Apple's decoder (and so the iPhone app) reads,
  // and plays what the iPhone app records, AAC made by Apple's encoder. Chromium has no
  // AAC encoder on Linux, so there it records Opus in MP4 (a known gap).
  const recorded = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // As the app picks (lib/voice.ts).
    const types = ["audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm;codecs=opus"];
    const recorder = new MediaRecorder(stream, { mimeType: types.find((type) => MediaRecorder.isTypeSupported(type)) });
    const chunks = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const done = new Promise((resolve) => (recorder.onstop = resolve));
    // In pieces, as the app records (lib/voice.ts).
    recorder.start(250);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    recorder.stop();
    await done;
    stream.getTracks().forEach((track) => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { type: recorder.mimeType, data: btoa(binary) };
  });
  // Saved everywhere, so a recording from Linux can be tried on a Mac.
  const desktopFile = join(shots, "desktop-voice.m4a");
  writeFileSync(desktopFile, Buffer.from(recorded.data, "base64"));
  if (process.platform === "linux") check("the desktop records in MP4", recorded.type.startsWith("audio/mp4"), recorded.type);
  else check("the desktop records AAC in MP4", recorded.type.startsWith("audio/mp4") && recorded.type.includes("mp4a"), recorded.type);
  if (process.platform === "darwin") {
    const info = execFileSync("afinfo", [desktopFile], { encoding: "utf8" });
    const decoded = join(shots, "desktop-voice.wav");
    execFileSync("afconvert", ["-f", "WAVE", "-d", "LEI16", desktopFile, decoded]);
    const decodedSeconds = (readFileSync(decoded).length - 44) / 2 / 48_000;
    check(
      "Apple's decoder reads the desktop's recording",
      /aac/i.test(info) && decodedSeconds > 0.8 && decodedSeconds < 1.3,
      `${info.match(/Data format:.*/)?.[0]}, ${decodedSeconds.toFixed(2)} s decoded`,
    );
    const wav = join(shots, "tone.wav");
    const appleFile = join(shots, "apple-voice.m4a");
    const samples = 16_000;
    const pcm = Buffer.alloc(44 + samples * 2);
    pcm.write("RIFF", 0); pcm.writeUInt32LE(36 + samples * 2, 4); pcm.write("WAVEfmt ", 8); pcm.writeUInt32LE(16, 16); pcm.writeUInt16LE(1, 20); pcm.writeUInt16LE(1, 22);
    pcm.writeUInt32LE(16_000, 24); pcm.writeUInt32LE(32_000, 28); pcm.writeUInt16LE(2, 32); pcm.writeUInt16LE(16, 34); pcm.write("data", 36); pcm.writeUInt32LE(samples * 2, 40);
    for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((i / 16_000) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
    writeFileSync(wav, pcm);
    execFileSync("afconvert", ["-f", "m4af", "-d", "aac", wav, appleFile]);
    const played = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/mp4" })));
      return new Promise((resolve) => {
        audio.onloadedmetadata = () => resolve(audio.duration);
        audio.onerror = () => resolve(-1);
      });
    }, readFileSync(appleFile).toString("base64"));
    check("the desktop plays AAC from Apple's encoder", played > 0.9 && played < 1.2, `${played} s`);
  }

  // Video messages: the camera in a circle while recording, then a circle in the chat that plays by
  // itself without sound, and from the start with it on a click.
  // What the app's recorder gives, kept to read back, since the page may not fetch its own files.
  await page.evaluate(() => {
    window.__recorded = [];
    const start = MediaRecorder.prototype.start;
    MediaRecorder.prototype.start = function (...args) {
      this.addEventListener("dataavailable", (event) => window.__recorded.push(event.data));
      return start.apply(this, args);
    };
  });
  await page.getByLabel("Record a video message").click();
  await page.locator(".round-preview video").waitFor();
  await sleep(2200);
  check("recording a video message shows the camera in a circle", await page.locator(".round-preview video").evaluate((video) => video.videoWidth > 0));
  await shot("19g3-recording-round");
  await page.getByLabel("Send video message").click();
  const round = page.locator(".msg.is-own.is-round .round").last();
  await round.locator("video").waitFor({ timeout: 20_000 });
  check("a video message shows its length", /^0:0[1-3]$/.test(await round.locator(".round-time").innerText()), await round.locator(".round-time").innerText());
  const looping = await round.locator("video").evaluate(
    (video) => new Promise((resolve) => setTimeout(() => resolve({ muted: video.muted, loop: video.loop, playing: !video.paused, at: video.currentTime, width: video.videoWidth, height: video.videoHeight }), 1200)),
  );
  check("a video message plays by itself, without sound, over and over", looping.muted && looping.loop && looping.playing && looping.at > 0, JSON.stringify(looping));
  check("a video message is square, 480 across", looping.width === 480 && looping.height === 480, `${looping.width}x${looping.height}`);
  await round.click();
  await page.locator(".round.is-heard").waitFor({ timeout: 5000 });
  const heard = await round.locator("video").evaluate((video) => ({ muted: video.muted, loop: video.loop, at: video.currentTime }));
  check("a click plays it from the start, with its sound", !heard.muted && !heard.loop && heard.at < 1, JSON.stringify(heard));
  await sleep(600);
  await shot("19g4-round");
  await round.click();
  // What the desktop records goes to the iPhone app, which reads it with Apple's AVFoundation.
  const roundFile = await page.evaluate(async () => {
    const bytes = new Uint8Array(await new Blob(window.__recorded).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
  const desktopRound = join(shots, "desktop-round.mp4");
  writeFileSync(desktopRound, Buffer.from(roundFile, "base64"));
  check("the desktop records video messages as MP4", Buffer.from(roundFile, "base64").subarray(4, 8).toString() === "ftyp");
  if (process.platform === "darwin") {
    const script = join(shots, "read-round.swift");
    writeFileSync(
      script,
      `import AVFoundation
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let video = try await asset.loadTracks(withMediaType: .video)
let audio = try await asset.loadTracks(withMediaType: .audio)
let size = try await video.first!.load(.naturalSize)
let codec = try await video.first!.load(.formatDescriptions).first.map { CMFormatDescriptionGetMediaSubType($0) } ?? 0
let generator = AVAssetImageGenerator(asset: asset)
let frame = try await generator.image(at: CMTime(seconds: 0.5, preferredTimescale: 600)).image
print(Int(size.width), Int(size.height), audio.count, codec == kCMVideoCodecType_H264 ? "h264" : "other", try await asset.load(.duration).seconds, frame.width)
`,
    );
    let read = "";
    try {
      read = execFileSync("xcrun", ["swift", script, desktopRound], { encoding: "utf8" }).trim();
    } catch (error) {
      read = String(error.stderr ?? error);
    }
    const [width, height, sounds, codec, seconds] = read.split(" ");
    check("AVFoundation reads the desktop's video message: H.264 with sound, square", width === "480" && height === "480" && sounds === "1" && codec === "h264" && Number(seconds) > 1, read);
  }

  // Picking several messages
  await page.locator(".msg", { hasText: "Perfect. Booking" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Select" }).click();
  await page.locator(".selection-bar").waitFor();
  await page.locator(".msg", { hasText: "The one by the lake" }).first().click();
  check("clicking messages picks them", (await page.locator(".selection-count").innerText()).startsWith("2 messages"), await page.locator(".selection-count").innerText());
  await shot("19h-selecting");
  await page.getByRole("button", { name: "Copy" }).click();
  await page.locator(".toast", { hasText: "Copied 2 messages" }).waitFor({ timeout: 5000 });
  check("copying several messages names their authors", (await electronApp.evaluate(({ clipboard }) => clipboard.readText())).includes("Sam Chen, ["));
  check("copying ends the selection", (await page.locator(".selection-bar").count()) === 0);
  // Dragging across messages picks them, as in Telegram's desktop app.
  const middleOf = async (text) => {
    const box = await page.locator(".msg", { hasText: text }).first().locator(".bubble").boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  const drag = async (from, ...through) => {
    const start = await middleOf(from);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const text of through) {
      const point = await middleOf(text);
      await page.mouse.move(point.x, point.y, { steps: 8 });
    }
    await page.mouse.up();
    await sleep(100);
  };
  const pickedCount = async () => ((await page.locator(".selection-bar").count()) ? await page.locator(".selection-count").innerText() : "none");
  const text = await page.locator(".msg", { hasText: "nice view at sunrise" }).first().locator(".msg-text").boundingBox();
  await page.mouse.move(text.x + 4, text.y + text.height / 2);
  await page.mouse.down();
  await page.mouse.move(text.x + text.width - 4, text.y + text.height / 2, { steps: 8 });
  await page.mouse.up();
  check("a drag within a message still selects its text", (await pickedCount()) === "none" && (await page.evaluate(() => window.getSelection()?.toString() ?? "")).includes("nice view"));
  await drag("Works for me", "Perfect. Booking", "Works for me");
  check("a drag that comes back picks only where it started, not toggling it on letting go", (await pickedCount()).startsWith("1 message"), await pickedCount());
  await page.keyboard.press("Escape");
  await drag("Works for me", "Perfect. Booking");
  check("dragging from one message onto another picks those between", (await pickedCount()).startsWith("3 messages"), await pickedCount());
  const selectedText = await page.evaluate(() => {
    const selection = window.getSelection();
    return selection?.toString() ? `${JSON.stringify(selection.toString().slice(0, 60))} in .${selection.anchorNode?.parentElement?.className}, focus on .${document.activeElement?.className}` : "";
  });
  check("dragging across messages doesn't select their text", !selectedText, selectedText);
  await shot("19h-dragged");
  await drag("I'll bring the tent", "The one by the lake");
  check("a drag from a picked message lets go of them", (await pickedCount()).startsWith("1 message"), await pickedCount());
  await page.keyboard.press("Escape");
  await page.locator(".msg", { hasText: "Perfect. Booking" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Select" }).click();
  await page.locator(".msg", { hasText: "The one by the lake" }).first().click();
  await page.getByRole("button", { name: "Forward" }).click();
  await page.locator(".forward-list .person-row", { hasText: "Saved messages" }).click();
  await page.locator(".chat-title", { hasText: "Saved messages" }).waitFor();
  await page.locator(".msg.is-own", { hasText: "The one by the lake" }).waitFor({ timeout: 10_000 });
  const savedTexts = await page.locator(".msg.is-own .msg-text").allInnerTexts();
  const booking = savedTexts.findIndex((text) => text.includes("Perfect. Booking"));
  check("forwarding several keeps their order", booking >= 0 && savedTexts[booking + 1]?.includes("The one by the lake"), savedTexts.slice(-3).join(" | "));
  await shot("19i-forwarded-several");

  // Muting for a while
  await page.locator(".conv-row").filter({ has: page.locator(".conv-title", { hasText: "Jordan Blake" }) }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mute" }).click();
  await shot("19j-mute-menu");
  await page.getByRole("menuitem", { name: "For 1 hour" }).click();
  const jordan = page.locator(".conv-row").filter({ has: page.locator(".conv-title", { hasText: "Jordan Blake" }) });
  await jordan.locator(".conv-muted").waitFor({ timeout: 5000 });
  await openChat("Jordan Blake");
  await page.getByLabel("Details", { exact: true }).click();
  const until = page.locator(".side-row-hint", { hasText: "Muted until" });
  await until.waitFor({ timeout: 5000 });
  check("a chat muted for an hour says until when", true, await until.innerText());
  await shot("19k-muted-until");
  await page.locator(".side-row").filter({ hasText: "Notifications" }).getByRole("switch").click();
  await until.waitFor({ state: "detached", timeout: 5000 });
  check("turning notifications back on unmutes it", (await jordan.locator(".conv-muted").count()) === 0);

  // Disappearing messages
  await page.locator(".side-row", { hasText: "Disappearing messages" }).click();
  await page.getByRole("menuitem", { name: "1 day" }).click();
  await page.locator(".system-pill", { hasText: "You set messages to disappear after 1 day" }).waitFor({ timeout: 10_000 });
  await page.locator(".chat-head .chat-timer").waitFor({ timeout: 5000 });
  check("turning on disappearing messages says so in the chat and the header", true);
  await page.keyboard.type("This one disappears tomorrow");
  await page.keyboard.press("Enter");
  const fleeting = page.locator(".msg.is-own", { hasText: "This one disappears tomorrow" });
  await fleeting.locator(".msg-timer").waitFor({ timeout: 10_000 });
  check("a message sent then is marked as one that disappears", true);
  await sleep(300);
  await shot("19l-disappearing");
  await page.locator(".side-row", { hasText: "Disappearing messages" }).click();
  await page.getByRole("menuitem", { name: "Off" }).click();
  await page.locator(".system-pill", { hasText: "You turned off disappearing messages" }).waitFor({ timeout: 10_000 });
  await page.locator(".chat-head .chat-timer").waitFor({ state: "detached", timeout: 5000 });
  check("turning them off takes the mark off the header", true);
  await page.getByLabel("Details", { exact: true }).click();

  // Marking a chat as unread from the list, which opening it takes off
  const priyaRow = page.locator(".conv-row").filter({ has: page.locator(".conv-title", { hasText: "Priya Nair" }) });
  await priyaRow.click({ button: "right" });
  if ((await page.getByRole("menuitem", { name: "Mark as read" }).count()) > 0) {
    await page.getByRole("menuitem", { name: "Mark as read" }).click();
    await priyaRow.locator(".conv-badge").waitFor({ state: "detached", timeout: 5000 });
    check("reading a chat from the list takes its count off", true);
    await priyaRow.click({ button: "right" });
  }
  await page.getByRole("menuitem", { name: "Mark as unread" }).click();
  await priyaRow.getByLabel("Marked as unread").waitFor({ timeout: 5000 });
  check("a chat marked as unread shows a mark in the list", true);
  await shot("19la-marked-unread");
  await openChat("Priya Nair");
  await priyaRow.getByLabel("Marked as unread").waitFor({ state: "detached", timeout: 5000 });
  check("opening it takes the mark off", true);

  // Blocking someone from their details: their chat leaves the list, and their messages fold away
  await page.getByLabel("Details", { exact: true }).click();
  await page.locator(".side-row", { hasText: "Block Priya Nair" }).click();
  await page.locator(".composer-disabled", { hasText: "You blocked Priya Nair" }).waitFor({ timeout: 5000 });
  check("blocking someone says so in place of the message box", true);
  await priyaRow.waitFor({ state: "detached", timeout: 5000 });
  check("someone blocked leaves the chat list", true);
  await page.getByLabel("Details", { exact: true }).click();
  await openChat("Weekend trip");
  const folded = page.locator(".msg.is-blocked").first();
  await folded.waitFor({ timeout: 5000 });
  check("a blocked person's messages fold into a line", true);
  await sleep(200);
  await shot("19lb-blocked-message");
  await folded.getByRole("button", { name: "Show" }).click();
  await page.locator(".msg:not(.is-blocked)", { hasText: "I'll sort out the food" }).waitFor({ timeout: 5000 });
  check("asking shows the message", true);

  // Notifying only about mentions, from a group's details
  await page.getByLabel("Details", { exact: true }).click();
  const onlyMentions = page.getByRole("switch", { name: "Only mentions" });
  await onlyMentions.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Only mentions"]')?.getAttribute("aria-checked") === "true", null, { timeout: 5000 });
  check("a group can notify only about mentions", true);
  await sleep(200);
  await shot("19lc-only-mentions");
  await onlyMentions.click();
  await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Only mentions"]')?.getAttribute("aria-checked") === "false", null, { timeout: 5000 });
  await page.getByLabel("Details", { exact: true }).click();

  // Who read your message in a group, from its menu
  await page.locator(".composer-input").click();
  await page.keyboard.type("Who's in for Saturday?");
  await page.keyboard.press("Enter");
  const asked = page.locator(".msg.is-own", { hasText: "Who's in for Saturday?" });
  await asked.locator(".msg-tick.is-read").waitFor({ timeout: 15_000 });
  await sleep(1500);
  await asked.locator(".bubble").click({ button: "right" });
  const readBy = page.getByRole("menuitem", { name: /^Read by \d+$/ });
  await readBy.waitFor({ timeout: 5000 });
  const readCount = Number((await readBy.innerText()).match(/\d+/)[0]);
  await readBy.click();
  const readers = await page.locator(".menu .menu-item").allInnerTexts();
  check("a message's menu lists who in the group read it", readers.length === readCount && readers.some((name) => name.includes("Sam Chen")), readers.join(", "));
  await shot("19ld-read-by");
  await page.keyboard.press("Escape");

  // Unblocking from Privacy settings brings their chat back
  await page.getByLabel("Settings", { exact: true }).click();
  await page.locator(".settings-nav-item", { hasText: "Privacy" }).click();
  const blockedRow = page.locator(".setting-row", { hasText: "Priya Nair" });
  await blockedRow.waitFor({ timeout: 5000 });
  await sleep(150);
  await shot("19le-blocked-people");
  await blockedRow.getByRole("button", { name: "Unblock" }).click();
  await blockedRow.waitFor({ state: "detached", timeout: 5000 });
  await page.keyboard.press("Escape");
  await priyaRow.waitFor({ timeout: 5000 });
  check("unblocking in Privacy brings their chat back", true);

  // Sharing a location, where Chromium is told where this device is. In saved
  // messages, where no bot answers and changes the chat's preview.
  await electronApp.context().setGeolocation({ latitude: 52.229676, longitude: 21.012229, accuracy: 25 });
  await openChat("Saved messages");
  await page.getByLabel("Attach", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Location" }).click();
  const found = page.locator(".share-location", { hasText: "52.22968° N, 21.01223° E" });
  await found.waitFor({ timeout: 15_000 });
  check("sharing a location shows where this device is first", (await found.innerText()).includes("Within 25 m"), (await found.innerText()).replace(/\n/g, " | "));
  await shot("19m-share-location");
  await page.getByRole("button", { name: "Send location" }).click();
  const placeCard = page.locator(".msg.is-own .location-card").last();
  await placeCard.waitFor({ timeout: 10_000 });
  check("a shared location shows as a place, linking to a map", (await placeCard.getAttribute("href"))?.startsWith("https://www.openstreetmap.org/?mlat=52.229676&mlon=21.012229") === true, await placeCard.getAttribute("href"));
  await sleep(300);
  check("the message box is ready after sharing a location", await composerFocused());
  await page.locator(".conv-row", { hasText: "Saved messages" }).locator(".conv-preview", { hasText: "Location" }).waitFor({ timeout: 10_000 });
  check("the chat list reads it as a location", true);
  await sleep(300);
  await shot("19n-location");

  // Search
  await page.locator("#conversation-search").fill("campsite");
  await sleep(500);
  await shot("21-search");
  await page.locator("#conversation-search").fill("");
  await openChat("Weekend trip");
  await page.getByLabel("Search this chat").click();
  await page.getByLabel("Search messages").fill("lake");
  await sleep(500);
  await shot("22-chat-search");
  await page.getByLabel("Pinned messages", { exact: true }).click();
  await sleep(200);
  await shot("23-pinned");
  await page.getByLabel("Pinned messages", { exact: true }).click();

  // Starting things
  await page.getByLabel("New group").click();
  await sleep(250);
  await shot("24-new-group");
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.locator(".server-title").click();
  await sleep(150);
  await shot("25-server-menu");
  await page.getByRole("menuitem", { name: "Invite people" }).click();
  await sleep(250);
  await shot("26-invite");
  await page.keyboard.press("Escape");
  await sleep(150);

  // Reordering servers
  const secondPort = port + 1;
  secondServer = spawn(binary, ["--listen", `127.0.0.1:${secondPort}`, "--data", secondData, "--public-url", `http://127.0.0.1:${secondPort}`, "--auth-burst", "1000"], { stdio: ["ignore", "pipe", "pipe"] });
  let secondOutput = "";
  secondServer.stdout.on("data", (chunk) => (secondOutput += chunk));
  secondServer.stderr.on("data", (chunk) => (secondOutput += chunk));
  const secondLink = await setupLink(() => secondOutput);
  await page.getByLabel("Join a server").click();
  await page.getByLabel("Invite link").fill(secondLink);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Alex Rivera", { timeout: 15_000 });
  await page.locator('input[type="password"]').fill("ui-check-only-Pass-9182");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Our corner of the internet").fill("Workshop");
  await page.getByRole("button", { name: "Finish" }).click();
  await page.locator('.rail-button[aria-label="Workshop"]').waitFor({ timeout: 20_000 });
  await sleep(300);
  const railOrder = (on = page) => on.locator(".rail-button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")).join(", "));
  const activeServer = () => page.locator('.rail-button[aria-current="true"]').getAttribute("aria-label");
  check("a new server goes to the end of the rail", (await railOrder()) === "Friends, Workshop", await railOrder());

  const friends = await page.locator('.rail-button[aria-label="Friends"]').boundingBox();
  const workshop = await page.locator('.rail-button[aria-label="Workshop"]').boundingBox();
  await page.mouse.move(friends.x + friends.width / 2, friends.y + friends.height / 2);
  await page.mouse.down();
  await page.mouse.move(friends.x + friends.width / 2, workshop.y + workshop.height / 2, { steps: 12 });
  await sleep(150);
  await shot("27-rail-dragging");
  await page.mouse.up();
  await sleep(500);
  check("dragging a server moves it along the rail", (await railOrder()) === "Workshop, Friends", await railOrder());
  check("letting go of a drag doesn't switch servers", (await activeServer()) === "Workshop", await activeServer());
  await page.locator('.rail-button[aria-label="Friends"]').click();
  await sleep(200);
  check("a click after a drag still switches servers", (await activeServer()) === "Friends", await activeServer());

  check("no errors in the page", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 400));

  await electronApp.close();
  electronApp = await electron.launch({
    args: [app, `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  const reopened = await electronApp.firstWindow();
  await reopened.locator(".rail-button").first().waitFor({ timeout: 30_000 });
  check("the rail's order survives a restart", (await railOrder(reopened)) === "Workshop, Friends", await railOrder(reopened));
} catch (error) {
  console.error("UI CHECK CRASHED:", error);
  console.error(errors.join("\n").slice(0, 2000));
  failures.push("crashed");
  try {
    const page = await electronApp.firstWindow();
    await page.screenshot({ path: join(shots, "crash.png") });
    console.error("Conversations:", await page.locator(".conv-row").allInnerTexts());
    const logs = await page.evaluate(() => window.__zunaLogs ?? []);
    if (logs.length) console.error("Logs:", logs);
  } catch {
    // The window may be gone.
  }
} finally {
  await electronApp?.close().catch(() => undefined);
  if (bots) {
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill", ["/pid", String(bots.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // It may have exited already.
      }
    } else {
      bots.kill();
    }
  }
  server.kill();
  secondServer?.kill();
  await sleep(300);
  for (const dir of [data, secondData, userData]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold files open for a moment after the app exits.
    }
  }
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nALL UI CHECKS PASSED");
  console.log(`Screenshots: ${shots}`);
  process.exitCode = failures.length ? 1 : 0;
}
