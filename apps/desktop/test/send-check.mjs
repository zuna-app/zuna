// Sends messages in the real Electron app, against a real server and live bots,
// and records what's on screen after every painted frame. It fails if a send
// makes the list jump back, hide or blank, or if a notice leaves its place.
//
//   npm run build -w @zuna/desktop && node apps/desktop/test/send-check.mjs [output-dir]

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const output = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-send-"));
mkdirSync(output, { recursive: true });

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const binary = join(tmpdir(), `zuna-send-server${process.platform === "win32" ? ".exe" : ""}`);
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], {
  cwd: join(root, "server"),
  env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
  stdio: "inherit",
});

const data = mkdtempSync(join(tmpdir(), "zuna-send-data-"));
const userData = mkdtempSync(join(tmpdir(), "zuna-send-user-"));
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
function check(name, passed, detail = "") {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}

/**
 * Runs in the page: samples the list as each frame is about to be painted, until
 * told to stop. Resize observers run after layout and just before paint. Changing a
 * nested element from inside one gets a second round, after all of the app's own
 * have run, however new they are, so this sees exactly what goes on screen.
 */
function startRecording() {
  const frames = [];
  let running = true;
  const marker = document.createElement("div");
  marker.style.cssText = "position:fixed;left:-10px;top:0;height:1px;width:1px";
  const inner = document.createElement("div");
  inner.style.cssText = "height:1px;width:1px";
  marker.append(inner);
  document.body.append(marker);
  const outerObserver = new ResizeObserver(() => {
    inner.style.width = inner.style.width === "1px" ? "2px" : "1px";
  });
  const observer = new ResizeObserver(() => {
    const scroller = document.querySelector("[data-virtuoso-scroller]");
    const list = document.querySelector('[data-testid="virtuoso-item-list"]');
    frames.push({
      t: Math.round(performance.now()),
      blank: !!document.querySelector(".list-center"),
      hidden: list ? getComputedStyle(list).visibility === "hidden" : false,
      scrollTop: scroller?.scrollTop ?? null,
      title: document.querySelector(".chat-title")?.textContent ?? "",
      viewportTop: scroller?.getBoundingClientRect().top ?? null,
      viewportBottom: scroller?.getBoundingClientRect().bottom ?? null,
      fromEnd: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : 0,
      scrollHeight: scroller?.scrollHeight ?? null,
      margin: list?.style.marginTop ?? null,
      padding: list ? `${list.style.paddingTop} ${list.style.paddingBottom}` : null,
      rows: [...document.querySelectorAll(".list-item")].map((item) => {
        const box = item.getBoundingClientRect();
        const words = item.querySelector(".msg-text")?.firstChild?.textContent ?? item.textContent;
        return { text: words.slice(0, 60), top: Math.round(box.top * 10) / 10, bottom: Math.round(box.bottom * 10) / 10 };
      }),
    });
  });
  outerObserver.observe(marker);
  observer.observe(inner);
  let wide = false;
  const tick = () => {
    if (!running) return;
    wide = !wide;
    marker.style.width = wide ? "2px" : "1px";
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  window.__stopRecording = () => {
    running = false;
    outerObserver.disconnect();
    observer.disconnect();
    marker.remove();
    return frames;
  };
}

/** What a viewer would call a flash, from the frames of one send. */
function analyse(frames, sentText) {
  const jumps = [];
  const missing = [];
  let blank = 0;
  let hidden = 0;
  // A chat with nothing in it yet is meant to be empty until its first message.
  const firstShown = frames.findIndex((frame) => frame.rows.length > 0);
  for (let i = 1; i < frames.length; i++) {
    const before = frames[i - 1];
    const now = frames[i];
    if (i > firstShown && now.blank) blank++;
    if (now.hidden) hidden++;
    const tops = new Map(now.rows.map((row) => [row.text, row.top]));
    for (const row of before.rows) {
      const inView = row.bottom > 60 && row.top < (before.viewportBottom ?? 0);
      const top = tops.get(row.text);
      if (top === undefined) {
        if (inView && now.rows.length > 0) missing.push(row.text);
        continue;
      }
      // Sending only ever moves what's on screen up. Moving down means it snapped back.
      if (top - row.top > 1.5) jumps.push(`${row.text.slice(0, 24)} +${Math.round(top - row.top)}px at frame ${i}`);
    }
  }
  const sentAt = frames.findIndex((frame) => frame.rows.some((row) => row.text.includes(sentText)));
  let shownAt = -1;
  for (let i = Math.max(sentAt, 0); i < frames.length; i++) {
    const row = frames[i].rows.find((item) => item.text.includes(sentText));
    if (row && row.bottom <= (frames[i].viewportBottom ?? 0) + 1) {
      shownAt = i;
      break;
    }
  }
  const last = frames[frames.length - 1];
  const sentRow = last?.rows.find((row) => row.text.includes(sentText));
  return {
    frames: frames.length,
    blank,
    hidden,
    jumps,
    missing: [...new Set(missing)],
    framesUntilVisible: sentAt >= 0 && shownAt >= 0 ? shownAt - sentAt : null,
    settled: !!sentRow && sentRow.bottom <= (last.viewportBottom ?? 0) + 1 && last.fromEnd <= 1,
    fromEnd: last?.fromEnd ?? 0,
  };
}

let electronApp;
let bots;
try {
  const link = await setupLink();
  electronApp = await electron.launch({
    args: [app, `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  let page = await electronApp.firstWindow();
  const errors = [];
  const prepareWindow = async () => {
    page.on("pageerror", (error) => errors.push(error.message));
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setSize(1280, 832);
      window.center();
    });
  };
  await prepareWindow();
  // To see how it holds up on a slower machine: ZUNA_CPU_SLOWDOWN=4
  const slowDown = async () => {
    const rate = Number(process.env.ZUNA_CPU_SLOWDOWN ?? 1);
    if (rate > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate });
  };

  const openChat = async (name) => {
    await page.locator(".conv-row").filter({ has: page.locator(".conv-title", { hasText: name }) }).first().click();
    await page.locator(".chat-title", { hasText: name }).waitFor();
  };
  /** Records while `act` runs and for a while after, then judges the frames. */
  const recorded = async (label, sentText, act, { settle = 900 } = {}) => {
    await page.evaluate(startRecording);
    await page.waitForTimeout(60);
    await act();
    await page.waitForTimeout(settle);
    const frames = await page.evaluate(() => window.__stopRecording());
    writeFileSync(join(output, `${label}.json`), JSON.stringify(frames));
    const result = analyse(frames, sentText);
    const clean = result.blank === 0 && result.hidden === 0 && result.jumps.length === 0 && result.missing.length === 0 && result.settled;
    check(
      `${label}: sending doesn't flash`,
      clean,
      [
        `${result.frames} frames`,
        `visible after ${result.framesUntilVisible} frames`,
        result.blank ? `blank ${result.blank}` : "",
        result.hidden ? `hidden ${result.hidden}` : "",
        result.jumps.length ? `jumps: ${result.jumps.slice(0, 4).join("; ")}` : "",
        result.missing.length ? `disappeared: ${result.missing.slice(0, 3).join("; ")}` : "",
        result.settled ? "" : `stopped ${result.fromEnd}px short of the end`,
      ]
        .filter(Boolean)
        .join(", "),
    );
    return result;
  };
  /** Opens a chat that's already been loaded, and judges every frame from the first that shows it. */
  const opened = async (label, name, { atEnd = true } = {}) => {
    await page.evaluate(startRecording);
    await page.waitForTimeout(60);
    const clickedAt = await page.evaluate((target) => {
      const row = [...document.querySelectorAll(".conv-row")].find((item) => item.querySelector(".conv-title")?.textContent.includes(target));
      const at = performance.now();
      row.click();
      return at;
    }, name);
    await page.waitForTimeout(700);
    const frames = await page.evaluate(() => window.__stopRecording());
    writeFileSync(join(output, `${label}.json`), JSON.stringify(frames));
    const shown = frames.filter((frame) => frame.t >= clickedAt && frame.title.includes(name));
    const first = shown[0];
    const hiddenFrames = shown.filter((frame) => frame.hidden || frame.blank || frame.rows.length === 0);
    const hiddenMs = hiddenFrames.length ? hiddenFrames[hiddenFrames.length - 1].t - first.t : 0;
    const newest = first?.rows[first.rows.length - 1];
    const inPlace = !!newest && (!atEnd || (first.fromEnd <= 1 && newest.bottom <= first.viewportBottom + 1));
    const filled = !!first?.rows.length && (first.rows[0].top <= first.viewportTop || first.fromEnd <= 1);
    const moved = [];
    for (let i = 1; i < shown.length; i++) {
      const tops = new Map(shown[i].rows.map((row) => [row.text, row.top]));
      for (const row of shown[i - 1].rows) {
        const top = tops.get(row.text);
        if (top !== undefined && Math.abs(top - row.top) > 1.5) moved.push(`${row.text.slice(0, 16)} ${Math.round(top - row.top)}px at frame ${i}`);
      }
    }
    check(
      `${label}: right in the first frame, then still`,
      hiddenFrames.length === 0 && inPlace && filled && moved.length === 0,
      [
        `painted ${Math.round(first.t - clickedAt)} ms after the click`,
        hiddenFrames.length ? `hidden or empty for ${hiddenMs} ms` : "",
        inPlace ? "" : `first frame ${first.fromEnd}px from the end`,
        filled ? "" : "first frame doesn't fill the list",
        moved.length ? `moved: ${moved.slice(0, 3).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join(", "),
    );
  };
  const sendText = async (text) => {
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };
  const rowOrder = () => page.evaluate(() => [...document.querySelectorAll(".list-item")].map((item) => (item.querySelector(".msg-text")?.firstChild?.textContent ?? item.textContent).slice(0, 40)));

  // Onboarding
  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Alex Rivera", { timeout: 15_000 });
  await page.locator('input[type="password"]').first().fill("send-check-only-Pass-9182");
  await page.getByLabel("Confirm password").fill("send-check-only-Pass-9182");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
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
  await sleep(1000);
  await slowDown();

  // A new group, which starts with a notice and has room to spare
  await page.getByLabel("New group").click();
  await page.getByPlaceholder("Weekend trip").fill("Probe group");
  await page.locator(".person-row", { hasText: "Lena" }).click();
  await page.getByRole("button", { name: /^Create/ }).click();
  await page.locator(".chat-title", { hasText: "Probe group" }).waitFor({ timeout: 20_000 });
  await page.locator(".system-pill", { hasText: "created this group" }).waitFor({ timeout: 10_000 });
  await sleep(400);
  for (let i = 1; i <= 5; i++) {
    await recorded(`new-group-${i}`, `short ${i}`, () => sendText(`short ${i}`));
    const order = await rowOrder();
    check(`new-group-${i}: the notice stays first`, order[0]?.includes("created this group"), order.join(" | "));
  }
  await page.screenshot({ path: join(output, "new-group.png") });
  await page.locator(".msg.is-own", { hasText: "short 1" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await page.locator(".msg.is-own", { hasText: "short 1" }).locator(".msg-pinned").waitFor({ timeout: 10_000 });
  await page.locator(".composer-input").click();

  // Fill the group so it scrolls, without watching.
  for (let i = 1; i <= 30; i++) await sendText(`filler ${i}`);
  await sleep(1200);
  for (let i = 1; i <= 5; i++) await recorded(`full-list-${i}`, `long ${i}`, () => sendText(`long ${i}`));

  // Several lines at once: the message box shrinks in the same moment.
  await recorded("multi-line", "line four", async () => {
    await page.keyboard.type("line one");
    for (const line of ["line two", "line three", "line four"]) {
      await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(line);
    }
    await sleep(150);
    await page.keyboard.press("Enter");
  });

  // A reply: the bar above the message box closes in the same moment.
  await page.locator(".msg.is-own", { hasText: "long 5" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply" }).click();
  await sleep(200);
  await recorded("reply", "answering", () => sendText("answering this"));

  // Leaving and coming back keeps the notice at the top of the history.
  await openChat("Weekend trip");
  await sleep(300);
  await openChat("Probe group");
  await sleep(500);
  const atBottom = await rowOrder();
  check("reopened: the notice isn't among the newest messages", !atBottom.slice(-5).some((text) => text.includes("created this group")), atBottom.slice(-3).join(" | "));
  await recorded("after-reopen", "back again", () => sendText("back again"));

  // The first message to someone: its group is created while it's on screen.
  await openChat("Marek");
  await sleep(300);
  await recorded("first-message", "hello marek", () => sendText("hello marek"), { settle: 1500 });

  // Someone else's message arriving, which brings typing with it.
  await openChat("Priya");
  await sleep(300);
  await recorded(
    "with-a-reply",
    "You said: are you there",
    async () => {
      await sendText("are you there");
      await page.locator(".chat-status.is-typing").waitFor({ timeout: 5000 });
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(output, "typing.png") });
    },
    { settle: 2500 },
  );
  check("a message from someone ends their typing", (await page.locator(".chat-status.is-typing").count()) === 0);

  // Opening a chat shows its messages in place in the first frame, and they then stay put.
  await openChat("Jordan");
  await page.waitForTimeout(300);
  await opened("open-long-chat", "Probe group");
  await page.waitForTimeout(200);
  await opened("open-other-chat", "Jordan");
  await page.waitForTimeout(200);
  await opened("open-long-chat-again", "Probe group");
  await page.waitForTimeout(200);
  await opened("open-short-chat", "Priya");
  await page.waitForTimeout(200);

  // Pinned messages only show in their panel.
  await page.locator(".msg.is-own", { hasText: "are you there" }).first().click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await page.locator(".msg.is-own", { hasText: "are you there" }).locator(".msg-pinned").waitFor({ timeout: 10_000 });
  check("a pinned message adds nothing above the chat", (await page.locator(".pinned-bar").count()) === 0);
  await page.getByLabel("Pinned messages", { exact: true }).click();
  await page.locator(".side-panel", { hasText: "are you there" }).waitFor({ timeout: 10_000 });
  check("a pinned message is listed in the panel", true);
  await page.getByLabel("Pinned messages", { exact: true }).click();

  // A chat with a lot unread opens at the first of them, under a line, and reads only
  // what's been on screen, as Telegram's does.
  await openChat("Lena");
  await page.locator(".composer-input").click();
  await sendText("count to 80");
  await page.locator(".msg.is-own", { hasText: "count to 80" }).waitFor({ timeout: 5000 });
  await openChat("Jordan");
  const lenaRow = page.locator(".conv-row").filter({ has: page.locator(".conv-title", { hasText: "Lena" }) }).first();
  const lenaUnread = async () => Number((await lenaRow.locator(".conv-badge").allTextContents())[0] ?? 0);
  for (let i = 0; i < 300 && (await lenaUnread()) < 80; i++) await sleep(100);
  await sleep(300);
  // Only a focused window reads, and the window the check drives may not have it.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await opened("open-unread-chat", "Lena", { atEnd: false });
  const line = await page.evaluate(() => {
    const view = document.querySelector("[data-virtuoso-scroller]").getBoundingClientRect();
    const separator = document.querySelector(".unread-sep");
    const text = separator?.closest(".list-item").querySelector(".msg-text");
    const time = text?.querySelector(".msg-meta")?.textContent ?? "";
    return separator && { top: Math.round(separator.getBoundingClientRect().top - view.top), text: text?.textContent.slice(0, -time.length || undefined).trim() };
  });
  check("a chat with unread messages opens at the first, under a line", !!line && line.top >= 0 && line.top < 30 && line.text === "Count 1", JSON.stringify(line));
  await page.screenshot({ path: join(output, "unread.png") });
  await sleep(1000);
  const readOnOpening = await lenaUnread();
  check("opening it reads only what's on screen", readOnOpening > 20 && readOnOpening < 80, `${readOnOpening} of 80 left`);
  check("the way down shows how many are unread", (await page.locator(".to-bottom .to-bottom-badge").textContent()) === String(readOnOpening));
  // Opened at its first unread message, the list starts at the very top of what's drawn,
  // where a wheel scrolls nothing. Going up still has to bring in what's above.
  const lineTop = () => page.evaluate(() => Math.round(document.querySelector(".unread-sep").getBoundingClientRect().top));
  const lineBefore = await lineTop();
  await page.locator("[data-virtuoso-scroller]").hover();
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -20);
    await sleep(25);
  }
  await sleep(400);
  const lineAfter = await lineTop();
  const asked = await page.evaluate(() => {
    const view = document.querySelector("[data-virtuoso-scroller]").getBoundingClientRect();
    const box = [...document.querySelectorAll(".msg.is-own")].find((item) => item.textContent.includes("count to 80"))?.getBoundingClientRect();
    return !!box && box.top >= view.top && box.bottom <= view.bottom;
  });
  check("going up from the first unread message brings in what's above", asked && lineAfter - lineBefore > 40, `the line moved ${lineAfter - lineBefore}px down, "count to 80" ${asked ? "" : "not "}on screen`);
  await page.locator("[data-virtuoso-scroller]").evaluate((element, by) => (element.scrollTop += by), lineAfter - lineBefore);
  await sleep(300);
  await page.mouse.wheel(0, 600);
  await sleep(1000);
  const readOnScrolling = await lenaUnread();
  check("scrolling down reads what comes on screen", readOnScrolling > 0 && readOnScrolling < readOnOpening, `${readOnOpening}, then ${readOnScrolling} left`);
  await page.locator(".to-bottom").click();
  await sleep(1000);
  check("the way down reads the rest", (await lenaUnread()) === 0, `${await lenaUnread()} left`);
  await openChat("Jordan");
  await page.waitForTimeout(300);
  await opened("open-read-chat", "Lena");
  check("once read, it opens at the newest message without the line", (await page.locator(".unread-sep").count()) === 0);
  // Going up in small steps, as a trackpad does, never puts it back at the end: a row
  // drawn above as the list moves once did, again and again.
  await page.locator("[data-virtuoso-scroller]").hover();
  await page.evaluate(startRecording);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, -10);
    await sleep(25);
  }
  await sleep(400);
  const smallSteps = await page.evaluate(() => window.__stopRecording());
  writeFileSync(join(output, "small-steps-up.json"), JSON.stringify(smallSteps));
  const snapsBack = smallSteps.filter((frame, i) => i > 0 && frame.fromEnd < smallSteps[i - 1].fromEnd - 2).length;
  const wentUp = smallSteps[smallSteps.length - 1]?.fromEnd ?? 0;
  check("small steps up don't snap back to the newest message", snapsBack === 0 && wentUp > 250, `${snapsBack} snaps back, ${wentUp}px up in the end`);

  // In a group, "@" goes to each unread mention of you that hasn't been on screen, oldest first.
  await openChat("Probe group");
  await page.locator(".composer-input").click();
  await sendText("count to 60");
  await page.locator(".msg.is-own", { hasText: "count to 60" }).waitFor({ timeout: 5000 });
  await openChat("Jordan");
  const probeRow = page.locator(".conv-row").filter({ has: page.locator(".conv-title", { hasText: "Probe group" }) }).first();
  for (let i = 0; i < 300 && Number((await probeRow.locator(".conv-badge:not(.conv-mention)").allTextContents())[0] ?? 0) < 60; i++) await sleep(100);
  await sleep(300);
  await openChat("Probe group");
  const toMention = page.locator(".to-mention");
  await toMention.waitFor({ timeout: 5000 });
  const mentionsLeft = async () => ((await toMention.count()) ? Number(await toMention.locator(".to-bottom-badge").textContent()) : 0);
  const waiting = await mentionsLeft();
  check("\"@\" counts the mentions that haven't been on screen", waiting >= 2 && waiting <= 3, `${waiting}`);
  await page.screenshot({ path: join(output, "mentions.png") });
  await toMention.click();
  const mentioned = page.locator(".msg.is-highlighted", { hasText: "@" });
  await mentioned.waitFor({ timeout: 5000 });
  const mentionText = await mentioned.locator(".msg-text").textContent();
  await sleep(800);
  check("\"@\" goes to the oldest first, then counts the rest", mentionText.startsWith(`Count ${80 - waiting * 20} `) && (await mentionsLeft()) === waiting - 1, `${mentionText}, ${await mentionsLeft()} left`);
  await page.locator(".to-bottom:not(.to-mention)").click();
  await sleep(1000);
  check("at the newest message \"@\" goes", (await toMention.count()) === 0 && (await probeRow.locator(".conv-badge").count()) === 0);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));

  // Scrolled up, a message from someone stays below and sending comes back down.
  await openChat("Probe group");
  await page.waitForTimeout(400);
  const scroller = page.locator("[data-virtuoso-scroller]");
  await scroller.hover();
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(300);
  const awayBefore = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  check("scrolling up shows the way back", awayBefore > 300 && (await page.locator(".to-bottom").count()) === 1, `${Math.round(awayBefore)}px up`);

  // Leaving and coming back keeps the place, to the pixel.
  const topRow = () =>
    page.evaluate(() => {
      const top = document.querySelector("[data-virtuoso-scroller]").getBoundingClientRect().top;
      const row = [...document.querySelectorAll(".list-item")].find((item) => item.getBoundingClientRect().bottom > top);
      return { text: row.querySelector(".msg-text")?.firstChild?.textContent ?? row.textContent, offset: Math.round(row.getBoundingClientRect().top - top) };
    });
  const placeBefore = await topRow();
  await openChat("Jordan");
  await page.waitForTimeout(300);
  await opened("open-scrolled-up", "Probe group", { atEnd: false });
  const placeAfter = await topRow();
  check("coming back to a chat keeps the place", placeAfter.text === placeBefore.text && Math.abs(placeAfter.offset - placeBefore.offset) <= 1, `${placeBefore.text} at ${placeBefore.offset}px, then ${placeAfter.text} at ${placeAfter.offset}px`);

  await page.locator(".composer-input").click();
  await page.keyboard.type("from up here");
  await page.keyboard.press("Enter");
  await page.locator(".msg.is-own", { hasText: "from up here" }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(400);
  const awayAfter = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  check("sending from further up goes all the way down", awayAfter <= 1 && (await page.locator(".to-bottom").count()) === 0, `${Math.round(awayAfter)}px from the end`);

  // How long each key takes to reach the screen.
  await page.evaluate(() => {
    window.__keyDelays = [];
    document.querySelector(".composer-input").addEventListener("keydown", () => {
      const start = performance.now();
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => window.__keyDelays.push(performance.now() - start);
        channel.port2.postMessage(0);
      });
    });
  });
  await page.keyboard.type("a fairly ordinary sentence, typed at a steady pace, to see how each key feels", { delay: 25 });
  await sleep(100);
  const delays = await page.evaluate(() => window.__keyDelays.sort((a, b) => a - b));
  const slowKey = delays[Math.floor(delays.length * 0.95)] ?? 0;
  check("typing reaches the screen within a frame or two", slowKey < 40, `95% within ${Math.round(slowKey)} ms, slowest ${Math.round(delays[delays.length - 1] ?? 0)} ms`);
  await page.locator(".composer-input").fill("");

  // The conversation list follows the newest message, not the notice.
  const preview = await page.locator(".conv-row", { hasText: "Probe group" }).locator(".conv-preview").innerText();
  check("the chat list previews the newest message", preview.includes("from up here"), preview);

  // After a restart only the newest page is in memory, and the rest takes a jump or scrolling.
  await openChat("Probe group");
  await page.locator(".composer-input").click();
  for (let i = 1; i <= 40; i++) await sendText(`older ${i}`);
  await sleep(2500);
  await electronApp.close();
  electronApp = await electron.launch({
    args: [app, `--user-data-dir=${userData}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "" },
  });
  page = await electronApp.firstWindow();
  await prepareWindow();
  await page.locator(".conv-row", { hasText: "Probe group" }).waitFor({ timeout: 30_000 });
  await slowDown();
  await page.evaluate(startRecording);
  await openChat("Probe group");
  await page.locator(".list-item").first().waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  writeFileSync(join(output, "open-after-restart.json"), JSON.stringify(await page.evaluate(() => window.__stopRecording())));

  // Nothing is left scrolling once a chat has settled, like two things fighting over its position.
  const scrollsWhileIdle = await page.locator("[data-virtuoso-scroller]").evaluate(
    (element) =>
      new Promise((resolve) => {
        let count = 0;
        const onScroll = () => count++;
        element.addEventListener("scroll", onScroll, { passive: true });
        setTimeout(() => {
          element.removeEventListener("scroll", onScroll);
          resolve(count);
        }, 500);
      }),
  );
  check("a settled chat doesn't keep scrolling", scrollsWhileIdle === 0, `${scrollsWhileIdle} scroll events in half a second`);
  const fromTheEnd = () => page.locator("[data-virtuoso-scroller]").evaluate((element) => Math.round(element.scrollHeight - element.clientHeight - element.scrollTop));
  check("after a restart a chat opens at its newest message", (await fromTheEnd()) <= 1, `${await fromTheEnd()}px from the end`);

  // A pin from long ago opens a window of older messages, and the way back leaves it.
  await page.getByLabel("Pinned messages", { exact: true }).click();
  await page.locator(".side-panel").getByText("short 1").first().click();
  const target = page.locator(".msg.is-highlighted", { hasText: "short 1" });
  await target.waitFor({ timeout: 10_000 });
  const targetInView = await target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = document.querySelector("[data-virtuoso-scroller]").getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  });
  check("a pin from long ago jumps to its message", targetInView);
  await page.screenshot({ path: join(output, "jump.png") });
  await page.getByLabel("Pinned messages", { exact: true }).click();
  await page.locator(".to-bottom").click();
  await page.locator(".msg.is-own", { hasText: "older 40" }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  check("the way back returns to the newest message", (await fromTheEnd()) <= 1 && (await page.locator(".to-bottom").count()) === 0, `${await fromTheEnd()}px from the end`);

  // Scrolling up loads the older pages. It only ever moves rows down the screen: one
  // moving up means that something pushed it.
  await page.locator("[data-virtuoso-scroller]").hover();
  await page.evaluate(startRecording);
  let reachedStart = false;
  for (let i = 0; i < 100 && !reachedStart; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(120);
    reachedStart = (await page.locator(".system-pill", { hasText: "created this group" }).count()) > 0;
  }
  await page.waitForTimeout(400);
  const scrollFrames = await page.evaluate(() => window.__stopRecording());
  writeFileSync(join(output, "scroll-up.json"), JSON.stringify(scrollFrames));
  const pushed = [];
  for (let i = 1; i < scrollFrames.length; i++) {
    const tops = new Map(scrollFrames[i].rows.map((row) => [row.text, row.top]));
    for (const row of scrollFrames[i - 1].rows) {
      const top = tops.get(row.text);
      if (top !== undefined && top - row.top < -1.5) pushed.push(`${row.text.slice(0, 16)} ${Math.round(top - row.top)}px at frame ${i}`);
    }
  }
  check("scrolling up reaches the start of the chat", reachedStart);
  check("older pages join without moving what's on screen", pushed.length === 0, `${scrollFrames.length} frames${pushed.length ? `, ${pushed.length} pushed: ${pushed.slice(0, 3).join("; ")}` : ""}`);
  await page.screenshot({ path: join(output, "start-of-chat.png") });

  // The arrow goes all the way down from far up.
  await page.locator(".to-bottom").click();
  await page.waitForTimeout(600);
  check("the arrow goes all the way down", (await fromTheEnd()) <= 1 && (await page.locator(".to-bottom").count()) === 0, `${await fromTheEnd()}px from the end`);

  // A pin that's loaded, but held back above the rows a chat opens with.
  await openChat("Jordan");
  await page.waitForTimeout(300);
  await opened("open-after-older-pages", "Probe group");
  check("the chat reopens at its newest message", (await fromTheEnd()) <= 1, `${await fromTheEnd()}px from the end`);
  await page.getByLabel("Pinned messages", { exact: true }).click();
  await page.locator(".side-panel").getByText("short 1").first().click();
  const heldTarget = page.locator(".msg.is-highlighted", { hasText: "short 1" });
  await heldTarget.waitFor({ timeout: 5000 });
  await page.waitForTimeout(150);
  const heldInView = await heldTarget.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const view = document.querySelector("[data-virtuoso-scroller]").getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  });
  check("a pin above the opening rows jumps to its message", heldInView);
  await page.getByLabel("Pinned messages", { exact: true }).click();

  check("no errors in the page", errors.length === 0, errors.slice(0, 3).join(" | ").slice(0, 400));
} catch (error) {
  console.error("SEND CHECK CRASHED:", error);
  failures.push("crashed");
  try {
    const page = await electronApp.firstWindow();
    await page.screenshot({ path: join(output, "crash.png") });
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
  console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join(", ")}` : "\nALL SEND CHECKS PASSED");
  console.log(`Frames: ${output}`);
  process.exitCode = failures.length ? 1 : 0;
}
