// The attacks anyone with an account could send, against the real Electron app:
// a message that used to blank the app on every launch, one that made it contact
// someone's server, and one that ran it out of stack.
//
//   npm run build -w @zuna/desktop-electron-legacy && node apps/desktop-electron-legacy/test/attack-check.mjs

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const binary = join(tmpdir(), `zuna-attack-server${process.platform === "win32" ? ".exe" : ""}`);
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], {
  cwd: join(root, "server"),
  env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
  stdio: "inherit",
});

const data = mkdtempSync(join(tmpdir(), "zuna-attack-data-"));
const userData = mkdtempSync(join(tmpdir(), "zuna-attack-user-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const url = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--listen", `127.0.0.1:${port}`, "--data", data, "--public-url", url, "--auth-burst", "1000"], { stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

const hits = [];
const tracker = createServer((request, response) => {
  hits.push(request.url);
  response.end();
});
await new Promise((resolve) => tracker.listen(0, "127.0.0.1", resolve));
const trackerUrl = `http://127.0.0.1:${tracker.address().port}`;

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

const launch = async () => {
  const launched = await electron.launch({ args: [app, `--user-data-dir=${userData}`], env: { ...process.env, ELECTRON_RENDERER_URL: "" } });
  const window = await launched.firstWindow();
  window.on("pageerror", (error) => errors.push(error.message));
  return { launched, window };
};

let electronApp;
let bot;
try {
  const link = await setupLink();
  let { launched, window: page } = await launch();
  electronApp = launched;

  await page.getByRole("button", { name: "Join with an invite" }).click({ timeout: 30_000 });
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Alex Rivera", { timeout: 15_000 });
  await page.locator('input[type="password"]').first().fill("attack-check-only-Pass-9182");
  await page.getByLabel("Confirm password").fill("attack-check-only-Pass-9182");
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

  bot = spawn("npx", ["vite-node", "test/attack-bot.ts", invite, trackerUrl], { cwd: join(root, "packages", "core"), shell: true, stdio: ["ignore", "pipe", "pipe"] });
  let botOutput = "";
  bot.stdout.on("data", (chunk) => (botOutput += chunk));
  bot.stderr.on("data", (chunk) => (botOutput += chunk));
  for (let i = 0; i < 240 && !botOutput.includes("Attacks sent"); i++) await sleep(250);
  if (!botOutput.includes("Attacks sent")) throw new Error(`the attacker didn't finish:\n${botOutput}`);

  const row = page.locator(".conv-row", { hasText: "Mallory" });
  await row.first().waitFor({ timeout: 20_000 });
  await sleep(1500);
  const rootChildren = () => page.evaluate(() => document.querySelector("#root")?.children.length ?? 0);
  check("the app is still here when the messages arrive", (await rootChildren()) > 0);

  await row.first().click();
  await page.locator(".chat-title", { hasText: "Mallory" }).waitFor();
  await sleep(1500);
  check("opening the chat doesn't take the app down", (await rootChildren()) > 0);
  check("a body that isn't a message says so", (await page.getByText("This message couldn't be displayed.").count()) > 0);
  check("opening the chat contacts nobody", hits.length === 0, hits.join(" "));

  const started = Date.now();
  await page.locator(".msg strong").first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await page.evaluate(() => {
    const scroller = document.querySelector("[data-virtuoso-scroller]");
    if (scroller) scroller.scrollTop = 0;
  });
  await sleep(1000);
  check("a message of 16,000 formatted spans renders", (await rootChildren()) > 0, `${Date.now() - started} ms`);

  const failed = await page.evaluate(async () => {
    const image = new Image();
    return new Promise((resolve) => {
      image.onload = () => resolve("loaded");
      image.onerror = () => resolve("blocked");
      image.src = "http://127.0.0.1:9/pixel.png";
    });
  });
  check("the content security policy refuses remote images", failed === "blocked", failed);

  await electronApp.close();
  ({ launched, window: page } = await launch());
  electronApp = launched;
  await page.locator(".conv-row", { hasText: "Mallory" }).first().waitFor({ timeout: 30_000 });
  await sleep(1000);
  check("the app starts again afterwards, where it used to stay blank", (await page.evaluate(() => document.querySelector("#root")?.children.length ?? 0)) > 0);
  check("still nobody contacted", hits.length === 0, hits.join(" "));
  check("no errors reached the page", errors.length === 0, errors.join(" | ").slice(0, 400));
} catch (error) {
  console.error("ATTACK CHECK CRASHED:", error);
  failures.push("crashed");
} finally {
  await electronApp?.close().catch(() => undefined);
  if (bot?.pid) {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(bot.pid), "/t", "/f"], { stdio: "ignore" });
    else bot.kill();
  }
  server.kill();
  tracker.close();
  await sleep(400);
  for (const dir of [data, userData]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold files open for a moment longer.
    }
  }
}
console.log(failures.length === 0 ? "\nALL ATTACK CHECKS PASSED" : `\n${failures.length} FAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
