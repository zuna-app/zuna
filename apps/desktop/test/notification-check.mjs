// Checks Windows's notifications and unread badge in the real app, against a real
// server and someone real to hear from: how they look and behave, as Telegram's do,
// and what the page showing them can reach. Screenshots of the screen itself go in the
// output folder, just the corner and the taskbar, to look at.
//
//   npm run build -w @zuna/desktop && node apps/desktop/test/notification-check.mjs [output-dir] [--real-input] [--scale=1.5]
//
// Playwright's mouse and keyboard go around the system, so clicks would reach a window
// that should let them through, and keys one that doesn't have focus. --real-input
// moves the real mouse, clicks and types, and puts the mouse back, to check that too.
// The app's own window sits under it all, so that's what it clicks on.
//
// --scale forces Chromium's scale, to check how things are drawn. With more than one
// monitor it isn't a real screen of that scale: Electron then reports each display's
// bounds scaled twice, so the cards can land on the wrong monitor, out of the pictures.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { _electron as electron } from "playwright-core";

if (process.platform !== "win32") {
  console.log("Only Windows draws its own notifications.");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const realInput = process.argv.includes("--real-input");
const scale = process.argv.find((arg) => arg.startsWith("--scale="))?.slice("--scale=".length);
const output = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? mkdtempSync(join(tmpdir(), "zuna-notifications-"));
mkdirSync(output, { recursive: true });

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const binary = join(tmpdir(), "zuna-notification-server.exe");
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], {
  cwd: join(root, "server"),
  env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
  stdio: "inherit",
});

const data = mkdtempSync(join(tmpdir(), "zuna-notification-data-"));
const userData = mkdtempSync(join(tmpdir(), "zuna-notification-user-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const url = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--listen", `127.0.0.1:${port}`, "--data", data, "--public-url", url, "--auth-burst", "1000"], { stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, condition, timeout = 15_000) {
  const start = Date.now();
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
const setupLink = () => until("the server", () => serverOutput.match(/http:\/\/\S+\/invite\/\S+/)?.[0]);

const failures = [];
/** Within a pixel: at 150% a position lands on what the screen's pixels allow. */
const about = (value, expected) => Math.abs(value - expected) <= 1;
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

/** Moves the real mouse, or clicks with it, by asking Windows. */
function realMouse(script) {
  const prelude = `Add-Type -Name M -Namespace Z -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);';`;
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", prelude + script], { encoding: "utf8" });
}

let electronApp;
let bot;
try {
  const link = await setupLink();
  electronApp = await electron.launch({ args: [app, `--user-data-dir=${userData}`, ...(scale ? [`--force-device-scale-factor=${scale}`] : [])], env: { ...process.env, ELECTRON_RENDERER_URL: "" } });
  const page = await electronApp.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Alex Rivera", { timeout: 15_000 });
  await page.locator('input[type="password"]').first().fill("notification-check-only-Pass-9182");
  await page.getByLabel("Confirm password").fill("notification-check-only-Pass-9182");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Our corner of the internet").fill("Friends");
  await page.getByRole("button", { name: "Finish" }).click();
  await page.locator(".conv-row").first().waitFor({ timeout: 20_000 });

  await page.locator(".server-title").click();
  await page.getByRole("menuitem", { name: "Invite people" }).click();
  await page.getByRole("button", { name: "Create invite link" }).click();
  const invite = await page.locator(".invite-link span").first().textContent({ timeout: 10_000 });
  await page.keyboard.press("Escape");

  bot = spawn("npx", ["vite-node", "test/notification-bot.ts", invite], { cwd: join(root, "packages", "core"), shell: true, stdio: ["pipe", "pipe", "pipe"] });
  let botOutput = "";
  bot.stdout.on("data", (chunk) => (botOutput += chunk));
  bot.stderr.on("data", (chunk) => (botOutput += chunk));
  const tell = (command) => bot.stdin.write(`${JSON.stringify(command)}\n`);
  const say = (text) => tell({ say: text });
  const saidId = (text) => until(`"${text}" to be sent`, () => botOutput.match(new RegExp(`Said \\{"text":"${text}","id":"([^"]+)"`))?.[1]);

  // Their first message makes the chat, and from then on anything not in the open chat notifies.
  say("first message");
  const row = page.locator(".conv-row", { hasText: "Sam Rivers" });
  await row.first().waitFor({ timeout: 60_000 });

  /** Runs in the main process: remembers what the taskbar and the tray are given. */
  await electronApp.evaluate(({ BrowserWindow, Tray }) => {
    const seen = (globalThis.__seen = { overlays: [], trayImages: [] });
    const overlay = BrowserWindow.prototype.setOverlayIcon;
    BrowserWindow.prototype.setOverlayIcon = function (image, description) {
      seen.overlays.push({ image: image ? image.toDataURL() : null, description });
      return overlay.call(this, image, description);
    };
    const setImage = Tray.prototype.setImage;
    Tray.prototype.setImage = function (image) {
      seen.trayImages.push(image.toDataURL());
      return setImage.call(this, image);
    };
  });
  const seenBadges = () => electronApp.evaluate(() => globalThis.__seen);
  const savePicture = (name, dataUrl) => writeFileSync(join(output, name), Buffer.from(dataUrl.split(",")[1], "base64"));

  // --- The page ---

  const notifications = await until(
    "the notifications' page",
    async () => {
      const found = electronApp.windows().find((item) => item.url().includes("notifications.html"));
      if (found) return found;
      say(`again ${Date.now()}`);
      await sleep(1500);
      return null;
    },
    30_000,
  );
  notifications.on("pageerror", (error) => errors.push(`notifications: ${error.message}`));
  await notifications.locator(".notice").first().waitFor({ timeout: 15_000 });

  const windowState = () =>
    electronApp.evaluate(({ BrowserWindow, screen }) => {
      const found = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("notifications.html"));
      const main = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes("notifications.html"));
      return {
        visible: found.isVisible(),
        onTop: found.isAlwaysOnTop(),
        focusable: found.isFocusable(),
        focused: found.isFocused(),
        bounds: found.getBounds(),
        workArea: screen.getDisplayMatching(main.getBounds()).workArea,
        scale: screen.getDisplayMatching(main.getBounds()).scaleFactor,
      };
    });
  /** The real screen, just the corner or the taskbar. */
  const shoot = async (name, side) => {
    const dataUrl = await electronApp.evaluate(
      async ({ desktopCapturer, screen }, side) => {
        const display = screen.getPrimaryDisplay();
        const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) };
        const [source] = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
        const scale = source.thumbnail.getSize().width / display.size.width;
        const area =
          side === "taskbar"
            ? { x: 0, y: display.workArea.y + display.workArea.height, width: display.size.width, height: display.size.height - display.workArea.height }
            : { x: display.size.width - 400, y: display.workArea.y + display.workArea.height - 560, width: 400, height: 560 };
        return source.thumbnail.crop({ x: Math.round(area.x * scale), y: Math.round(area.y * scale), width: Math.round(area.width * scale), height: Math.round(area.height * scale) }).toDataURL();
      },
      side,
    );
    savePicture(name, dataUrl);
  };

  const state = await windowState();
  console.log(`screen scale ${state.scale}, work area ${JSON.stringify(state.workArea)}`);
  check("the window is on top of everything", state.onTop && state.visible);
  check("it can't take focus while it's only showing something", !state.focusable && !state.focused);
  check(
    "it sits in the corner of the main window's screen",
    state.bounds.x + state.bounds.width === state.workArea.x + state.workArea.width && state.bounds.y + state.bounds.height === state.workArea.y + state.workArea.height,
    JSON.stringify(state.bounds),
  );

  // --- What the page can reach ---

  const origin = await notifications.evaluate(() => location.origin);
  check("it has an origin of its own, not the app's", origin === "zuna-app://notifications", origin);
  check("it has nothing of the app's bridge", await notifications.evaluate(() => window.zunaDesktop === undefined && typeof require === "undefined" && typeof process === "undefined"));
  const keyRefused = await electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    const handler = ipcMain._invokeHandlers?.get?.("zuna:device-key");
    const found = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("notifications.html"));
    if (!handler) return "no handler to try";
    return Promise.resolve()
      .then(() => handler({ sender: found.webContents, senderFrame: found.webContents.mainFrame }))
      .then(
        () => "handed out",
        (error) => error.message,
      );
  });
  check("the device key is refused to it, even by the app's rules", /Blocked/.test(keyRefused), keyRefused);
  const reach = await notifications.evaluate(async () => {
    const image = new Image();
    const remote = await new Promise((resolve) => {
      image.onload = () => resolve("loaded");
      image.onerror = () => resolve("blocked");
      image.src = "http://127.0.0.1:9/pixel.png";
    });
    const fetched = await fetch("http://127.0.0.1:9/x").then(
      () => "fetched",
      () => "blocked",
    );
    const stored = await navigator.storage.getDirectory().then(async (directory) => {
      const names = [];
      for await (const name of directory.keys()) names.push(name);
      return names;
    });
    return { remote, fetched, stored };
  });
  check("its content security policy refuses remote images and requests", reach.remote === "blocked" && reach.fetched === "blocked", JSON.stringify(reach));
  check("it can't see the app's database", reach.stored.length === 0);

  // --- How one looks ---

  const clearAll = async () => {
    await page.evaluate(() => window.zunaDesktop.clearNotifications({}));
    await until("the corner to clear", async () => (await notifications.locator(".notice").count()) === 0);
  };
  await clearAll();
  await until("the window to hide", async () => !(await windowState()).visible);
  check("with nothing to show, the window goes away", true);

  say("Are you around later? I found that place we talked about, the one with the long garden out back, and I think they still have room for Saturday");
  await notifications.locator(".notice").first().waitFor();
  await sleep(300);
  const box = await notifications.locator(".notice").first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, right: innerWidth - rect.right, bottom: innerHeight - rect.bottom };
  });
  check("a card is 320 × 80, 6px from the side and 7px from the bottom, as Telegram's", about(box.width, 320) && about(box.height, 80) && about(box.right, 6) && about(box.bottom, 7), JSON.stringify(box));
  const content = await notifications.locator(".notice").first().evaluate((element) => {
    const of = (selector) => element.querySelector(selector).getBoundingClientRect();
    const card = element.getBoundingClientRect();
    return {
      title: element.querySelector(".name").textContent,
      photo: { left: of(".photo").left - card.left, top: of(".photo").top - card.top, width: of(".photo").width },
      textLeft: of(".text").left - card.left,
      clamped: element.querySelector(".text").scrollHeight > element.querySelector(".text").clientHeight,
      closeRight: card.right - of(".close").right,
    };
  });
  check("its title is who said it", content.title === "Sam Rivers", content.title);
  check("the picture is 62px, 9px in", about(content.photo.left, 9) && about(content.photo.top, 9) && about(content.photo.width, 62), JSON.stringify(content.photo));
  check("the text starts 12px past it, and stops at two lines", about(content.textLeft, 83) && content.clamped, JSON.stringify(content));
  await shoot("1-one-card.png", "corner");
  await notifications.screenshot({ path: join(output, "1-one-card-page.png"), omitBackground: true });

  // --- Text only ---

  await clearAll();
  say("<img src=x onerror=document.title='owned'><b>bold</b>");
  await notifications.locator(".notice").first().waitFor();
  const markup = await notifications.evaluate(() => ({
    pictures: document.querySelectorAll(".body img, .body b").length,
    text: document.querySelector(".body").textContent,
    title: document.title,
  }));
  check("what someone sent only ever shows as text", markup.pictures === 0 && markup.title === "Zuna notifications" && markup.text.includes("onerror"), markup.text);

  // --- A stack ---

  await clearAll();
  for (const text of ["one", "two", "three", "four", "five"]) {
    say(text);
    await sleep(120);
  }
  await until("three cards", async () => (await notifications.locator(".notice").count()) === 3);
  await sleep(400);
  const stack = await notifications.evaluate(() =>
    [...document.querySelectorAll(".notice, .hide-all:not([hidden])")]
      .map((element) => ({ text: element.querySelector(".body")?.textContent ?? element.textContent, top: element.getBoundingClientRect().top, bottom: innerHeight - element.getBoundingClientRect().bottom, height: element.getBoundingClientRect().height }))
      .sort((a, b) => b.top - a.top),
  );
  check("three show at a time, oldest first, with the newest at the bottom", stack.slice(0, 3).map((item) => item.text).join() === "three,two,one", JSON.stringify(stack.map((item) => item.text)));
  check("7px apart", about(stack[1].bottom, stack[0].bottom + stack[0].height + 7), JSON.stringify(stack.map((item) => item.bottom)));
  check("\"Hide all\" sits on top of them, 36px high", stack[3]?.text === "Hide all" && about(stack[3].height, 36));
  await shoot("2-stack.png", "corner");
  await notifications.locator(".notice", { hasText: "one" }).first().click({ button: "right" });
  await until("the next from the queue", async () => (await notifications.locator(".notice", { hasText: "four" }).count()) === 1);
  check("right-clicking one closes it, and the next waiting takes its place", true);
  await notifications.locator(".notice", { hasText: "two" }).locator(".close").click();
  await until("the last from the queue", async () => (await notifications.locator(".notice", { hasText: "five" }).count()) === 1);
  check("so does its ×", true);
  await sleep(200);
  await notifications.locator(".hide-all").click();
  await until("them all to go", async () => (await notifications.locator(".notice").count()) === 0);
  check("\"Hide all\" takes them all", true);

  // --- How long they stay ---

  const setIdle = (seconds) =>
    electronApp.evaluate(({ powerMonitor }, seconds) => {
      powerMonitor.getSystemIdleTime = () => seconds;
    }, seconds);
  await setIdle(3600);
  say("while you were out");
  await notifications.locator(".notice").first().waitFor();
  await sleep(9000);
  const whileAway = await notifications.evaluate(() => getComputedStyle(document.querySelector(".notice")).opacity);
  check("with nobody at the computer, it stays as long as it takes", whileAway === "1", `opacity ${whileAway} after 9s`);
  await setIdle(0);
  const back = Date.now();
  await until("it to start fading", async () => Number(await notifications.evaluate(() => getComputedStyle(document.querySelector(".notice")).opacity)) < 0.95, 12_000);
  const started = Date.now() - back;
  check("with someone back, it starts to go after about 3 seconds", started > 2500 && started < 7000, `${started} ms`);
  await notifications.locator(".notice").first().hover();
  await sleep(400);
  const held = await notifications.evaluate(() => getComputedStyle(document.querySelector(".notice")).opacity);
  check("the mouse stops it and brings it back", held === "1", `opacity ${held}`);
  const replyShown = await notifications.evaluate(() => getComputedStyle(document.querySelector(".actions")).opacity);
  check("and shows Reply", Number(replyShown) > 0.9, replyShown);
  await shoot("3-hover.png", "corner");
  await page.mouse.move(10, 10);
  await notifications.mouse.move(2, 2);
  await until("it to go by itself", async () => (await notifications.locator(".notice").count()) === 0, 8000);
  check("leaving lets it fade away, within 4 seconds", true);

  // --- Replying ---

  say("did you see this");
  const repliedTo = await saidId("did you see this");
  await notifications.locator(".notice").first().waitFor();
  await notifications.locator(".notice").first().hover();
  await notifications.locator(".reply").click();
  const whileTyping = await windowState();
  check("Reply is the one thing that may take focus", whileTyping.focusable);
  const field = notifications.locator("textarea");
  await field.waitFor();
  await until("the field to have focus", () => field.evaluate((element) => document.activeElement === element));
  await sleep(250);
  const grown = await notifications.locator(".notice").first().evaluate((element) => element.getBoundingClientRect().height);
  check("the field opens under the card", about(grown, 116), `${grown}`);
  await field.fill("sounds good");
  await field.press("Shift+Enter");
  await field.pressSequentially("see you then");
  await sleep(300);
  await shoot("4-replying.png", "corner");
  await field.press("Enter");
  await until("the reply to reach them", () => botOutput.includes('Received {"text":"sounds good\\nsee you then"'));
  check("the reply reaches them, with its line break", true);
  check("in a direct message it isn't marked as answering anything", botOutput.includes('"text":"sounds good\\nsee you then","reply":null'), repliedTo);
  await until("the card to go", async () => (await notifications.locator(".notice").count()) === 0);
  await until("focus to go back", async () => !(await windowState()).focusable);
  check("sending takes the card and gives focus back", true);
  await until("replying to read the chat", async () => (await row.first().locator(".conv-badge").count()) === 0, 8000);
  check("replying reads the chat", true);

  say("never mind");
  await notifications.locator(".notice").first().waitFor();
  await notifications.locator(".notice").first().hover();
  await notifications.locator(".reply").click();
  await field.press("Escape");
  await until("Escape to close it", async () => (await notifications.locator(".notice").count()) === 0);
  check("Escape closes it", true);

  // --- A group ---

  say("(making a group)");
  await notifications.locator(".notice").first().waitFor();
  await clearAll();
  tell({ group: "Weekend trip" });
  await until("the group", () => botOutput.includes("Grouped"));
  await page.locator(".conv-row", { hasText: "Weekend trip" }).first().waitFor({ timeout: 20_000 });
  tell({ sayInGroup: "who's driving?" });
  const inGroup = await until("the group's message to be sent", () => botOutput.match(/SaidInGroup {"id":"([^"]+)"/)?.[1]);
  const groupCard = notifications.locator(".notice", { hasText: "who's driving?" }).first();
  await groupCard.waitFor({ timeout: 15_000 });
  await sleep(300);
  const group = await groupCard.evaluate((element) => ({
    title: element.querySelector(".name").textContent,
    author: element.querySelector(".author").textContent,
    body: element.querySelector(".body").textContent,
    icon: !element.querySelector(".group-icon").hasAttribute("hidden"),
    picture: element.querySelector(".photo img:not([hidden])")?.naturalWidth ?? 0,
  }));
  check("a group's card names the group, with who said it apart from what they said", group.title === "Weekend trip" && group.author.startsWith("Sam Rivers:") && group.body === "who's driving?" && group.icon, JSON.stringify(group));
  check("and shows the group's real picture, drawn small", group.picture === 124, `${group.picture}`);
  await shoot("3-group.png", "corner");
  await groupCard.hover();
  await groupCard.locator(".reply").click();
  await groupCard.locator("textarea").fill("I can");
  await groupCard.locator("textarea").press("Enter");
  await until("the group's reply", () => botOutput.includes('Received {"text":"I can"'));
  check("in a group a reply answers the message it came from", botOutput.includes(`"text":"I can","reply":"${inGroup}"`), inGroup);
  await until("the card to go", async () => (await notifications.locator(".notice").count()) === 0);
  await until("focus to go back", async () => !(await windowState()).focusable);

  // --- Clicking ---

  say("open me");
  await notifications.locator(".notice").first().waitFor();
  await notifications.locator(".notice").first().click();
  await page.locator(".chat-title", { hasText: "Sam Rivers" }).waitFor({ timeout: 10_000 });
  check("clicking one opens its chat", true);
  await until("the card to go", async () => (await notifications.locator(".notice").count()) === 0);

  // --- Taken back ---

  await page.getByText("Saved messages").first().click();
  await page.locator(".chat-title", { hasText: "Saved messages" }).waitFor();
  // With something else unread, so that it can't go just for the chat being read.
  say("keep this");
  say("take this back");
  await saidId("take this back");
  await notifications.locator(".notice", { hasText: "take this back" }).first().waitFor();
  tell({ delete: "take this back" });
  await until("the card to go with the message", async () => (await notifications.locator(".notice", { hasText: "take this back" }).count()) === 0);
  check("a message deleted takes its notification with it", true);
  check("and only its own", (await notifications.locator(".notice", { hasText: "keep this" }).count()) === 1);

  say("read me elsewhere");
  await notifications.locator(".notice", { hasText: "read me elsewhere" }).first().waitFor();
  await row.first().click();
  await page.locator(".chat-title", { hasText: "Sam Rivers" }).waitFor();
  const focusedMain = await electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes("notifications.html"));
    main.focus();
    return main.isFocused();
  });
  if (focusedMain) {
    await until("reading it to take the card", async () => (await notifications.locator(".notice").count()) === 0, 10_000);
    check("reading a chat takes its notifications", true);
  } else {
    console.log("SKIP  reading a chat takes its notifications: this desktop wouldn't give the window focus");
    await clearAll();
  }

  // --- Which screen ---

  const displays = await electronApp.evaluate(({ screen }) => screen.getAllDisplays().map((display) => display.workArea));
  if (displays.length > 1 && !scale) {
    for (const area of [...displays, displays[0]]) {
      await clearAll();
      await until("the window to hide", async () => !(await windowState()).visible);
      await electronApp.evaluate(({ BrowserWindow }, area) => {
        BrowserWindow.getAllWindows()
          .find((item) => !item.webContents.getURL().includes("notifications.html"))
          .setBounds({ x: area.x + 100, y: area.y + 100, width: 1000, height: 700 });
      }, area);
      await page.evaluate(() => window.zunaDesktop.notify({ title: "Which screen", body: "This one", route: { serverId: "", key: "" } }));
      await notifications.locator(".notice").first().waitFor();
      const { bounds } = await windowState();
      check("the cards go to the corner of the main window's screen", bounds.x + bounds.width === area.x + area.width && bounds.y + bounds.height === area.y + area.height, JSON.stringify(bounds));
    }
    await clearAll();
  }

  // --- What notifications may show ---

  await page.getByText("Saved messages").first().click();
  await page.locator(".chat-title", { hasText: "Saved messages" }).waitFor();
  const setPreview = (value) =>
    page.evaluate((value) => {
      const stored = JSON.parse(localStorage.getItem("zuna-settings") ?? "{}");
      localStorage.setItem("zuna-settings", JSON.stringify({ ...stored, notificationPreview: value }));
    }, value);
  await setPreview("none");
  await page.reload();
  await page.locator(".conv-row").first().waitFor({ timeout: 30_000 });
  await page.getByText("Saved messages").first().click();
  await sleep(500);
  say("secret plans");
  await notifications.locator(".notice").first().waitFor({ timeout: 20_000 });
  const hidden = await notifications.locator(".notice").first().evaluate((element) => ({
    title: element.querySelector(".name").textContent,
    body: element.querySelector(".text").textContent,
    logo: !element.querySelector(".logo").hasAttribute("hidden"),
    canReply: element.classList.contains("can-reply"),
  }));
  check("showing nothing shows nothing, and offers no reply", hidden.title === "Zuna" && hidden.body === "New message" && hidden.logo && !hidden.canReply, JSON.stringify(hidden));
  await sleep(300);
  await shoot("5-nothing-shown.png", "corner");
  await clearAll();
  await setPreview("full");
  await page.reload();
  await page.locator(".conv-row").first().waitFor({ timeout: 30_000 });
  await page.getByText("Saved messages").first().click();

  // --- Windows wants quiet ---

  await electronApp.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers;
    const original = handlers.get("zuna:notification-state");
    globalThis.__state = original;
    handlers.set("zuna:notification-state", () => ({ show: false, sound: false, waitForInput: true }));
  });
  say("during a game");
  await saidId("during a game");
  await sleep(2500);
  check("full screen or Do Not Disturb shows nothing", (await notifications.locator(".notice").count()) === 0);
  await electronApp.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.set("zuna:notification-state", globalThis.__state));
  const answer = await page.evaluate(() => window.zunaDesktop.notificationState());
  console.log(`Windows says right now: ${JSON.stringify(answer)}`);

  // --- The badge ---

  const counter = transformSync(readFileSync(join(app, "src", "renderer", "src", "counter.ts"), "utf8"), { loader: "ts", format: "iife", globalName: "counter" }).code;
  for (const count of [1, 7, 42, 128, 2531]) {
    const pictures = await page.evaluate(`${counter}; counter.drawCounters(${count})`);
    savePicture(`6-count-${count}-overlay.png`, pictures.overlay);
    savePicture(`6-count-${count}-tray.png`, pictures.tray);
    await page.evaluate(([count, pictures]) => window.zunaDesktop.setBadge(count, pictures), [count, pictures]);
    await sleep(700);
    await shoot(`6-count-${count}-taskbar.png`, "taskbar");
  }
  await until("an overlay", async () => (await seenBadges()).overlays.some((item) => item.image));
  const first = await seenBadges();
  const last = first.overlays.findLast((item) => item.image);
  check("the taskbar's button gets a picture and says how many", /\d+ unread/.test(last.description), last.description);
  savePicture("6-overlay.png", last.image);
  if (first.trayImages.length > 0) savePicture("6-tray.png", first.trayImages.at(-1));
  await shoot("6-taskbar.png", "taskbar");

  const before = (await seenBadges()).overlays.length;
  await electronApp.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes("notifications.html"));
    main.hide();
    main.show();
  });
  await sleep(600);
  const afterShow = await seenBadges();
  check("a window that was hidden gets its badge back", afterShow.overlays.length > before && afterShow.overlays.at(-1).image !== null);
  await shoot("7-taskbar-after-hiding.png", "taskbar");

  // --- The real mouse ---

  if (realInput) {
    const position = realMouse("Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; Write-Output \"$($p.X),$($p.Y)\"").trim().split(",").map(Number);
    try {
      const places = await electronApp.evaluate(({ BrowserWindow, screen }) => {
        const main = BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes("notifications.html"));
        const area = screen.getPrimaryDisplay().workArea;
        main.setBounds({ x: area.x + area.width - 900, y: area.y + area.height - 700, width: 900, height: 700 });
        main.focus();
        const inPixels = (x, y) => screen.dipToScreenPoint({ x, y });
        return {
          card: inPixels(area.x + area.width - 60, area.y + area.height - 50),
          above: inPixels(area.x + area.width - 60, area.y + area.height - 480),
          scale: screen.getPrimaryDisplay().scaleFactor,
        };
      });
      await page.evaluate(() => {
        globalThis.__clicks = 0;
        document.addEventListener("mousedown", () => globalThis.__clicks++, true);
      });
      await page.getByText("Saved messages").first().click();
      await sleep(300);
      say("real mouse");
      await notifications.locator(".notice", { hasText: "real mouse" }).first().waitFor({ timeout: 15_000 });
      await sleep(300);

      const before = await page.evaluate(() => globalThis.__clicks);
      realMouse(`[Z.M]::SetCursorPos(${places.above.x}, ${places.above.y}); Start-Sleep -Milliseconds 150; [Z.M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [Z.M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero);`);
      await sleep(300);
      const through = await page.evaluate(() => globalThis.__clicks);
      check("a click on the empty part of the window goes through to what's under it", through === before + 1, `${through - before} click(s) reached the app`);

      realMouse(`[Z.M]::SetCursorPos(${places.card.x}, ${places.card.y}); Start-Sleep -Milliseconds 100; [Z.M]::SetCursorPos(${places.card.x - 3}, ${places.card.y}); Start-Sleep -Milliseconds 100; [Z.M]::SetCursorPos(${places.card.x - 6}, ${places.card.y}); Start-Sleep -Milliseconds 150`);
      await sleep(350);
      const hovered = await notifications.evaluate(() => !!document.querySelector(".notice:hover"));
      check("the real mouse over a card counts as over it", hovered);
      const replyVisible = await notifications.evaluate(() => getComputedStyle(document.querySelector(".actions")).opacity);
      check("and shows Reply", Number(replyVisible) > 0.9, replyVisible);
      await shoot("8-real-hover.png", "corner");

      const beforeCard = await page.evaluate(() => globalThis.__clicks);
      realMouse(`[Z.M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [Z.M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero);`);
      await page.locator(".chat-title", { hasText: "Sam Rivers" }).waitFor({ timeout: 10_000 });
      check("a real click on a card opens its chat, and doesn't go through", (await page.evaluate(() => globalThis.__clicks)) === beforeCard);

      await page.getByText("Saved messages").first().click();
      await page.locator(".chat-title", { hasText: "Saved messages" }).waitFor();
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((item) => !item.webContents.getURL().includes("notifications.html")).focus());
      say("real typing");
      const typingCard = notifications.locator(".notice", { hasText: "real typing" }).first();
      await typingCard.waitFor({ timeout: 15_000 });
      await sleep(300);
      const reply = await typingCard.locator(".reply").evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      const onScreen = await electronApp.evaluate(({ BrowserWindow, screen }, reply) => {
        const bounds = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes("notifications.html")).getBounds();
        return screen.dipToScreenPoint({ x: bounds.x + reply.x, y: bounds.y + reply.y });
      }, reply);
      // Over the card first, which is what makes the button appear and the window take clicks.
      realMouse(`[Z.M]::SetCursorPos(${onScreen.x - 20}, ${onScreen.y}); Start-Sleep -Milliseconds 100; [Z.M]::SetCursorPos(${onScreen.x}, ${onScreen.y}); Start-Sleep -Milliseconds 400; [Z.M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [Z.M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero);`);
      await until("the field to open", () => notifications.locator("textarea:visible").count());
      await sleep(300);
      const focus = await windowState();
      check("a real click on Reply gives the window the system's focus", focus.focused, JSON.stringify({ focused: focus.focused, focusable: focus.focusable }));
      await shoot("9-real-replying.png", "corner");
      // To look at: replying shouldn't put a button for the notifications on the taskbar.
      await shoot("9-taskbar-while-replying.png", "taskbar");
      realMouse(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("typed for real{ENTER}");`);
      await until("the typed reply", () => botOutput.includes('Received {"text":"typed for real"'), 8000);
      check("real keys go into the reply, and Enter sends it", true);
      await until("focus to go back", async () => !(await windowState()).focusable);
    } finally {
      realMouse(`[Z.M]::SetCursorPos(${position[0]}, ${position[1]});`);
    }
  }

  check("nothing went wrong in either page", errors.length === 0, errors.join("; "));
  console.log(`\nPictures: ${output}`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILED:\n  ${failures.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log("NOTIFICATION CHECK PASSED.");
  }
} catch (error) {
  console.error("NOTIFICATION CHECK FAILED:", error);
  process.exitCode = 1;
} finally {
  if (bot) {
    try {
      execFileSync("taskkill", ["/pid", String(bot.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      bot.kill();
    }
  }
  await electronApp?.close().catch(() => undefined);
  server.kill();
  rmSync(data, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
}
