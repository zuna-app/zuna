// Notifications across one person's devices, as Telegram sends them: the web app
// in Chromium, standing for a computer, and the iPhone app in the simulator, signed
// in as the same person, a second phone that's only a push registration, and a real
// server with a stand-in for zuna-push that hands pushes to the simulator. It checks
// which of them is told about each message, and when.
//
//   npm run build -w @zuna/web && npm run test:ios:notify [-- screenshot-dir]
//
// The web app is in use while its window has focus and there was input in it in the
// last 30 s. Both are the page's own events here: input is a pointer moving every
// second while someone's "at the desktop", and focus comes and goes as the window's.
//
// simctl can't allow notifications, so the app has to have been allowed them on the
// E2E simulator before, as the UI tests' NotificationTests do, and it's installed
// over the last build to keep that.

import { execFile, execFileSync } from "node:child_process";
import { createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestApp, TestServer, loadCrypto, sleep, waitFor } from "../../../packages/core/test/helpers";
import { HostApp } from "./host";
import { root } from "./paths";
import { BUNDLE_ID, appPath, boot, buildApp, simulatorId } from "./simulator";
import { startWebApp, type WebApp } from "./web-app";

const shots = process.argv.find((arg, index) => index > 1 && !arg.startsWith("-")) ?? mkdtempSync(join(tmpdir(), "zuna-ios-notify-"));
mkdirSync(shots, { recursive: true });
const failures: string[] = [];
function check(name: string, passed: boolean, detail = ""): void {
  console.log(`${passed ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!passed) failures.push(name);
}
const log = (message: string) => console.log(`[notify-run] ${message}`);

/** How long a notification waits while its person is on another device: the server's and the apps'. */
const WAIT = 30_000;
/** And while they use both. */
const BOTH = 1_500;
/**
 * How long the server holds every push, since nothing says who sent a message: long enough for
 * the sender's own read to spare their phones (`defaultPushHold` in server/internal/api/push.go).
 */
const HOLD = 1_500;
const PASSWORD = "notify-check-Pass-Bob-4417";

// --- The phone ---

log("building the core bundle and the app");
execFileSync(process.execPath, [join(root, "apps", "ios", "core-bundle", "build.mjs")], { stdio: "inherit" });
buildApp();
const udid = simulatorId();
boot(udid);
// Over the last install, which keeps notifications allowed.
execFileSync("xcrun", ["simctl", "install", udid, appPath]);
/** Out of sight for real, as switching to another app is, and back. */
const phoneAway = () => execFileSync("xcrun", ["simctl", "launch", udid, "com.apple.Preferences"]);
const phoneBack = () => execFileSync("xcrun", ["simctl", "launch", udid, BUNDLE_ID]);

// --- A stand-in for zuna-push ---

interface Push {
  handle: string;
  type: string;
  at: number;
  data: { r: string; p: string };
}
const pushes: Push[] = [];
let phoneHandles = new Set<string>();
const relayServer = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const json = JSON.parse(body || "{}");
    if (request.url === "/v1/register") {
      const handles = Array.from({ length: json.count }, () => `iphone-${randomBytes(4).toString("hex")}`);
      phoneHandles = new Set(handles);
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ handles }));
      return;
    }
    if (request.url === "/v1/push") {
      pushes.push({ handle: json.handle, type: json.type, at: Date.now(), data: json.data });
      if (phoneHandles.has(json.handle)) {
        const file = join(shots, `push-${Date.now()}-${pushes.length}.json`);
        const aps =
          json.type === "background"
            ? { "content-available": 1 }
            : { alert: { title: "Zuna", body: "New message" }, "mutable-content": 1, sound: "default", category: "message" };
        writeFileSync(file, JSON.stringify({ aps, zuna: json.data }));
        execFile("xcrun", ["simctl", "push", udid, BUNDLE_ID, file], () => undefined);
      }
      response.end("{}");
      return;
    }
    response.statusCode = 404;
    response.end();
  });
});
await new Promise<void>((resolve) => relayServer.listen(0, "127.0.0.1", resolve));
const relayUrl = `http://127.0.0.1:${(relayServer.address() as AddressInfo).port}`;

/** What a push says, opened with the key its device gave the server. */
function openPush(key: Buffer, push: Push): Record<string, string> | null {
  try {
    const sealed = Buffer.from(push.data.p, "base64");
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
    decipher.setAAD(Buffer.from(`zuna/push/v1|${push.data.r}`));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString());
  } catch {
    return null;
  }
}

loadCrypto();
const server = new TestServer({ pushRelays: [relayUrl] });
await server.start();

let desktop: WebApp | null = null;
let phone: HostApp | null = null;
const others: TestApp[] = [];

try {
  const alice = await new TestApp("alice").open();
  others.push(alice);
  await alice.register(server.setupLink, "alice");
  const invite = await alice.session.createInvite(0, 0);

  // --- The web app, signed up as bob ---
  log("starting the web app");
  desktop = await startWebApp({ name: "notify-desktop" });
  const { page } = desktop;
  page.on("console", (message) => {
    if (message.type() === "error" || process.env.NOTIFY_DEBUG) console.log(`  [desktop] ${message.type()}: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __shown: { title: string; body: string; at: number }[]; __input: (on: boolean) => void };
    // What the web app would show, allowed and kept rather than shown on this Mac.
    w.__shown = [];
    class Kept extends EventTarget {
      static readonly permission = "granted";
      static requestPermission = async () => "granted";
      onclick: (() => void) | null = null;
      onclose: (() => void) | null = null;
      constructor(title: string, options?: NotificationOptions) {
        super();
        w.__shown.push({ title, body: options?.body ?? "", at: Date.now() });
      }
      close() {}
    }
    window.Notification = Kept as unknown as typeof Notification;
    // Someone at the computer, moving the pointer every second, or not. Each move goes
    // somewhere new, as the app takes one that stays put for the page moving under the pointer.
    let timer: ReturnType<typeof setInterval> | undefined;
    let at = 0;
    w.__input = (on) => {
      clearInterval(timer);
      const move = () => window.dispatchEvent(new PointerEvent("pointermove", { screenX: ++at, screenY: at }));
      if (on) {
        move();
        timer = setInterval(move, 1000);
      }
    };
  });
  await page.goto(desktop.url);
  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await page.getByLabel("Invite link").fill(invite);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Bob", { timeout: 15_000 });
  await page.getByLabel("Username").fill("bob");
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator(".server-title").waitFor({ timeout: 20_000 });
  await waitFor(() => alice.session.getUsers().some((user) => user.username === "bob"), "alice to see bob");
  const bobId = alice.session.getUsers().find((user) => user.username === "bob")!.id;

  /** Whether the person is at the desktop, moving the pointer. */
  const input = (state: "active" | "idle") => page.evaluate((on) => (window as unknown as { __input: (on: boolean) => void }).__input(on), state === "active");
  const focusDesktop = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
  const leaveDesktop = () => page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const shownOnDesktop = () => page.evaluate(() => (window as unknown as { __shown: { title: string; body: string; at: number }[] }).__shown);
  await input("idle");
  await leaveDesktop();

  // --- The phone, signed in as bob with notifications, and a second one that's only a push registration ---
  log("starting the app in the simulator");
  phone = await new HostApp("bob-iphone", {
    target: "simulator",
    args: ["-ZunaAskForNotifications", "YES", "-ZunaPushRelay", relayUrl, "-ZunaPushToken", "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"],
  }).open();
  await phone.login(server.url, "bob", PASSWORD);
  const thePhone = phone;
  const registered = await waitFor(() => phoneHandles.size > 0, "the phone to register with the relay", 30_000).then(
    () => true,
    () => false,
  );
  if (!registered) {
    const allowed = await thePhone.hostCommand("notificationsAllowed");
    throw new Error(
      allowed === "yes"
        ? "the phone didn't register with the relay"
        : "Zuna isn't allowed notifications on the E2E simulator: run `npm run test:ios:ui -- --only NotificationTests` once, which allows them",
    );
  }
  const ipad = await new TestApp("bob-ipad").open();
  others.push(ipad);
  await ipad.login(server.url, "bob", PASSWORD);
  const ipadKey = randomBytes(32);
  await ipad.session.setPush({ relay: relayUrl, handle: "ipad", key: ipadKey, registration: randomBytes(16).toString("hex"), sendMuted: true });

  // A chat for each case, so what one reads doesn't clear another's.
  const chats: Record<string, string> = { dm: `user:${bobId}` };
  for (const name of ["Desk", "Read here", "Left", "Both", "Phone"]) {
    chats[name] = `group:${await alice.session.createGroup(name, [bobId], false)}`;
  }
  alice.session.sendMessage(chats.dm!, { text: "Hi Bob" });
  for (const name of ["Desk", "Read here", "Left", "Both", "Phone"]) {
    await page.locator(".conv-row", { hasText: name }).waitFor({ timeout: 30_000 });
    await waitFor(async () => (await thePhone.session.getConversations()).some((item) => item.title === name), `the phone to have ${name}`, 30_000);
    await waitFor(() => ipad.session.getConversations().some((item) => item.title === name), `the second phone to have ${name}`, 30_000);
  }
  const groupOf = (chat: string) => alice.session.getConversations().find((item) => item.key === chat)!.groupId!;
  // Nothing from setting up counts.
  await sleep(2_000);
  await thePhone.hostCommand("clearNotifications");
  const phoneKeys = JSON.parse(await thePhone.hostCommand("pushKeys")) as Record<string, string>;
  const keyFor = (push: Push) => (push.handle === "ipad" ? ipadKey : phoneKeys[push.data.r] ? Buffer.from(phoneKeys[push.data.r]!, "base64") : null);
  const pushedAt = (handle: "iphone" | "ipad", messageId: string) =>
    pushes.find((push) => (handle === "ipad" ? push.handle === "ipad" : phoneHandles.has(push.handle)) && push.type === "alert" && openPush(keyFor(push)!, push)?.m === messageId)?.at;
  const activeElsewhere = () => ipad.session.isActiveElsewhere();

  /** Whether something came when it should: at once, after the server's hold on every push, after the wait, after a moment's wait, or never. */
  type When = "now" | "held" | "waited" | "moment" | "never";
  const judge = (name: string, at: number | undefined, sent: number, when: When) => {
    const delay = at === undefined ? undefined : at - sent;
    const ok =
      when === "never"
        ? delay === undefined
        : delay !== undefined &&
          (when === "now"
            ? delay < BOTH
            : when === "held"
              ? delay >= HOLD - 300 && delay < HOLD + 3_000
              : when === "moment" ? delay >= BOTH - 300 && delay < 8_000 : delay >= WAIT - 1_000 && delay < WAIT + 10_000);
    check(name, ok, delay === undefined ? "nothing" : `after ${(delay / 1000).toFixed(1)} s`);
  };
  const send = (chat: string, text: string) => ({ id: alice.session.sendMessage(chat, { text }).id, text, sent: Date.now() });
  const onDesktop = async (text: string) => (await shownOnDesktop()).find((item) => item.body.includes(text))?.at;
  const onPhone = async (messageId: string) =>
    (JSON.parse(await thePhone.hostCommand("notifications")) as { messageId: string; pushed: boolean; at: number }[]).find((item) => item.messageId === messageId && !item.pushed)?.at;

  // --- A: nobody's at the desktop, and the phone was just put away ---
  log("the phone put away, nobody at the desktop");
  phoneAway();
  await waitFor(() => !activeElsewhere(), "the phone to be put away", 15_000);
  await sleep(1_000);
  const a = send(chats.dm!, "Are you there?");
  await sleep(WAIT + 10_000);
  judge("used last, the phone is pushed once the server's hold is over", pushedAt("iphone", a.id), a.sent, "held");
  judge("the other phone waits, as bob was on the first one more recently", pushedAt("ipad", a.id), a.sent, "waited");
  judge("so does the desktop", await onDesktop(a.text), a.sent, "waited");

  // --- In front, with nobody touching it ---
  // Coming in front counts as input, so it's in use for 30 s, and no longer.
  await focusDesktop();
  await waitFor(() => activeElsewhere(), "the server to hear the desktop came in front", 15_000);
  await sleep(WAIT + 2_000);
  check("in front, but with no input for a while, the desktop isn't in use", !activeElsewhere());

  // --- B: at the desktop ---
  log("at the desktop");
  await input("active");
  await focusDesktop();
  await waitFor(() => activeElsewhere(), "the server to hear bob is at the desktop", 15_000);
  check("in front, with input, the desktop is in use", true);
  const b1 = send(chats.Desk!, "Lunch at one?");
  const b2 = send(chats["Read here"]!, "Read this at your desk");
  await sleep(3_000);
  await page.locator(".conv-row", { hasText: "Read here" }).click();
  await page.locator(".msg", { hasText: "Read this at your desk" }).waitFor({ timeout: 10_000 });
  await sleep(WAIT + 7_000);
  judge("in use, the desktop shows a message at once", await onDesktop(b1.text), b1.sent, "now");
  judge("the phone is pushed after the wait", pushedAt("iphone", b1.id), b1.sent, "waited");
  judge("so is the other phone", pushedAt("ipad", b1.id), b1.sent, "waited");
  judge("what's read at the desktop meanwhile isn't pushed to the phone", pushedAt("iphone", b2.id), b2.sent, "never");
  judge("nor to the other phone", pushedAt("ipad", b2.id), b2.sent, "never");
  await page.locator(".conv-row", { hasText: "Saved messages" }).click();

  // --- C: leaving the desktop ---
  log("leaving the desktop");
  await leaveDesktop();
  const left = Date.now();
  await waitFor(() => !activeElsewhere(), "the desktop to stop counting as in use", 15_000);
  const after = Date.now() - left;
  check("it stops counting as soon as it's left, as Telegram's", after < 3_000, `after ${(after / 1000).toFixed(1)} s`);
  const c = send(chats.Left!, "Gone already?");
  await sleep(WAIT + 10_000);
  judge("used last, the desktop shows it at once", await onDesktop(c.text), c.sent, "now");
  judge("the phone waits, as bob was at the desktop more recently", pushedAt("iphone", c.id), c.sent, "waited");
  judge("so does the other phone", pushedAt("ipad", c.id), c.sent, "waited");

  // --- Back at the desktop ---
  await input("active");
  await focusDesktop();
  await waitFor(() => activeElsewhere(), "bob to be back at the desktop", 15_000);

  // --- The phone shows what it was pushed ---
  log("the phone open, and the desktop in use");
  phoneBack();
  await sleep(5_000);
  const shown = JSON.parse(await thePhone.hostCommand("notifications")) as { messageId: string; pushed: boolean }[];
  const pushedHere = (id: string) => shown.some((item) => item.pushed && item.messageId === id);
  check("the phone shows what it was pushed", [a.id, b1.id, c.id].every(pushedHere), `${shown.length} notifications`);

  // --- F: using both ---
  const f = send(chats.Both!, "Phone or desk?");
  await sleep(WAIT + 7_000);
  judge("using both, the phone shows it itself after a moment", await onPhone(f.id), f.sent, "moment");
  judge("and the desktop after a moment", await onDesktop(f.text), f.sent, "moment");
  judge("nothing is pushed to the phone in use", pushedAt("iphone", f.id), f.sent, "never");
  judge("the other phone waits", pushedAt("ipad", f.id), f.sent, "waited");
  execFileSync("xcrun", ["simctl", "io", udid, "screenshot", join(shots, "phone.png")]);

  // --- G: only on the phone ---
  log("only on the phone");
  await input("idle");
  await leaveDesktop();
  await sleep(7_000);
  const g = send(chats.Phone!, "Read this on your phone");
  // Before it's read there, which takes the notification away.
  await waitFor(async () => (await onPhone(g.id)) !== undefined, "the phone to show it", 15_000).catch(() => undefined);
  const gOnPhone = await onPhone(g.id);
  const gGroup = groupOf(chats.Phone!);
  const { messages } = await thePhone.session.loadMessages(gGroup);
  const seq = messages.find((message) => message.id === g.id)?.seq;
  if (seq) await thePhone.session.markRead(gGroup, seq);
  await sleep(WAIT + 7_000);
  judge("in use, the phone shows it at once", gOnPhone, g.sent, "now");
  judge("read there, the desktop never shows it", await onDesktop(g.text), g.sent, "never");
  judge("nor is the other phone pushed", pushedAt("ipad", g.id), g.sent, "never");

  // --- H: what the server no longer counts the phone as showing ---
  // A silent push says a chat was read elsewhere, and iOS hands those over when it likes, so the app also asks
  // the server which chats it still counts it as showing, and clears the rest. The simulator gets no silent
  // push, and a read elsewhere reaches an app that's running over its socket, so here the server is made to
  // stop counting by turning its pushes off, and the app is asked to look, as a silent push has it do.
  log("what the server no longer counts");
  const h = send(chats.Left!, "Still on your screen?");
  await waitFor(async () => (await onPhone(h.id)) !== undefined, "the phone to show it", 15_000).catch(() => undefined);
  check("in use, the phone shows it itself", (await onPhone(h.id)) !== undefined);
  check("counted by the server as shown, it stays", (await thePhone.hostCommand("clearRead", { path: server.url })) === "0" && (await onPhone(h.id)) !== undefined);
  const shownNow = async () => (JSON.parse(await thePhone.hostCommand("notifications")) as unknown[]).length;
  const before = await shownNow();
  await thePhone.session.setPush(null);
  const cleared = Number(await thePhone.hostCommand("clearRead", { path: server.url }));
  check("no longer counted, what it showed and what it was pushed are cleared", cleared > 0 && cleared === before && (await shownNow()) === 0, `cleared ${cleared} of ${before}`);
  await page.screenshot({ path: join(shots, "desktop.png") });
} catch (error) {
  check("the run finished", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
  console.error(error);
  // Where each app was when it stopped.
  await desktop?.page.screenshot({ path: join(shots, "stopped-desktop.png") }).catch(() => undefined);
  try {
    execFileSync("xcrun", ["simctl", "io", udid, "screenshot", join(shots, "stopped-phone.png")], { stdio: "ignore" });
  } catch {
    // The simulator may be gone too.
  }
} finally {
  await phone?.close();
  await desktop?.close();
  for (const other of others) other.client.stop();
  await server.stop();
  relayServer.close();
}

console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join("; ")}` : "\nALL NOTIFICATION CHECKS PASSED");
console.log(`Screenshots and pushes: ${shots}`);
process.exit(failures.length ? 1 : 0);
