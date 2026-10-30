// Drives the real Electron app against a real server and live bots, checks how
// the interface behaves, and saves screenshots to look over.
//
//   npm run build -w @zuna/desktop && node apps/desktop/test/ui-check.mjs [screenshot-dir]

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
execFileSync("go", ["build", "-o", binary, "./cmd/zuna-server"], {
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
async function setupLink() {
  for (let i = 0; i < 200; i++) {
    const match = serverOutput.match(/http:\/\/\S+\/invite\/\S+/);
    if (match) return match[0];
    await sleep(50);
  }
  throw new Error(`the server didn't start:\n${serverOutput}`);
}

const failures = [];
const errors = [];
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

let electronApp;
let bots;
try {
  const link = await setupLink();
  electronApp = await electron.launch({
    args: [app, `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("WebSocket")) errors.push(message.text());
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
  };

  // Onboarding
  await page.getByLabel("Invite link").fill(link, { timeout: 30_000 });
  await sleep(200);
  await shot("01-welcome");
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
  await page.keyboard.press("Escape");
  await openChat("Priya");
  await page.locator(".chat-title").click();
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
  await page.getByText("Appearance", { exact: true }).click();
  await sleep(100);
  await shot("14-appearance");
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

  check("no errors in the page", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 400));
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
  await sleep(300);
  for (const dir of [data, userData]) {
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
