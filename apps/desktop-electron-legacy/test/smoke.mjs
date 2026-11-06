// Smoke test of the production build in real Electron: sandbox, custom protocol,
// content security policy, OS keychain, encrypted storage, and a real server, reached
// by its IP address with a certificate it makes itself, which the app trusts by its pin.
//
//   npm run build -w @zuna/desktop-electron-legacy && node apps/desktop-electron-legacy/test/smoke.mjs [screenshot-dir]
//
// This can't drive a packaged build: its fuses refuse the --inspect flag Playwright needs.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const root = join(app, "..", "..");
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "zuna-shots-"));
mkdirSync(shots, { recursive: true });

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);
const binary = join(tmpdir(), `zuna-smoke-server${process.platform === "win32" ? ".exe" : ""}`);
execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-server"], {
  cwd: join(root, "server"),
  env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
  stdio: "inherit",
});

const data = mkdtempSync(join(tmpdir(), "zuna-smoke-data-"));
const userData = mkdtempSync(join(tmpdir(), "zuna-smoke-user-"));
const port = 21000 + Math.floor(Math.random() * 20000);
const server = spawn(binary, ["--domain", "127.0.0.1", "--listen", `127.0.0.1:${port}`, "--data", data, "--push-relays", "off"], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => (output += chunk));
server.stderr.on("data", (chunk) => (output += chunk));

async function setupLink() {
  for (let i = 0; i < 200; i++) {
    const match = output.match(/https:\/\/\S+\/invite\/\S+#pin=\S+/);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the server didn't start:\n${output}`);
}

const launchOptions = {
  args: [app, `--user-data-dir=${userData}`],
  env: { ...process.env, ELECTRON_RENDERER_URL: "" },
};

const errors = [];
let electronApp;
try {
  const link = await setupLink();
  electronApp = await electron.launch(launchOptions);
  const page = await electronApp.firstWindow();
  page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => undefined);

  const origin = await page.evaluate(() => location.origin);
  console.log("origin:", origin);
  if (!origin.startsWith("zuna-app://")) throw new Error(`unexpected origin ${origin}`);

  const sandboxed = await page.evaluate(() => typeof require === "undefined" && typeof process === "undefined");
  if (!sandboxed) throw new Error("the renderer can reach Node, so it isn't sandboxed");
  console.log("renderer sandboxed: yes");

  // Previews connect through the main process's proxy, which only reaches public addresses.
  // This build may reach this machine by name, for its test pages, but not a name that leads there.
  const proxy = await electronApp.evaluate(({ session }) => session.fromPartition("zuna-web-checked").resolveProxy("https://example.com/"));
  const proxyPort = Number(proxy.match(/^PROXY 127\.0\.0\.1:(\d+)$/)?.[1]);
  if (!proxyPort) throw new Error(`previews don't go through their proxy: ${proxy}`);
  for (const target of ["10.0.0.1:443", "[fd00::1]:443", "192.168.1.1:443", "localtest.me:443", "example.com:22"]) {
    const answer = await new Promise((resolve) => {
      const socket = connect(proxyPort, "127.0.0.1", () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("close", () => resolve(text));
      socket.on("error", () => resolve(text));
    });
    if (!String(answer).startsWith("HTTP/1.1 403")) throw new Error(`the preview proxy let ${target} through: ${answer}`);
  }
  console.log("previews only connect where they're checked: yes");

  await page.getByRole("button", { name: "Join with an invite" }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(shots, "1-welcome.png") });
  await page.getByRole("button", { name: "Join with an invite" }).click();
  // Without its pin, or with another, the server's own certificate is refused. Chromium
  // remembers what it decided, which mustn't keep the right pin out afterwards.
  const pin = link.replace(/^.*#pin=/, "");
  for (const wrong of [link.replace(/#.*$/, ""), link.replace(pin, "A".repeat(43))]) {
    await page.getByLabel("Invite link").fill(wrong);
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".field-error").waitFor({ timeout: 15_000 });
  }
  console.log("a certificate without its pin, or with another, is refused: yes");
  await page.getByLabel("Invite link").fill(link);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Smoke Tester", { timeout: 15_000 });
  await page.locator('input[type="password"]').first().fill("smoke-test-only-Pass-9182");
  await page.getByLabel("Confirm password").fill("smoke-test-only-Pass-9182");
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Save your recovery key").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(shots, "2-recovery.png") });
  await page.getByText("I've stored it somewhere safe").click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("Our corner of the internet").fill("Smoke Server");
  await page.getByRole("button", { name: "Finish" }).click();

  await page.getByText("Saved messages").first().waitFor({ timeout: 20_000 });
  await page.getByText("Saved messages").first().click();
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("Hello from the **real** app:\n```go\nfunc main() { println(\"encrypted\") }\n```");
  await composer.press("Enter");
  await page.locator(".code-block").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector(".msg .msg-meta .msg-tick:not(.is-sending)"), null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "3-chat.png") });
  console.log("sent and rendered a message");

  // Another device needs the pin too, so the address to sign in with carries it.
  await page.getByLabel("Settings", { exact: true }).click();
  await page.getByRole("button", { name: "Security" }).click();
  await page.getByText(`${link.replace(/\/invite\/.*$/, "")}#pin=${pin}`).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: join(shots, "3b-address.png") });
  await page.keyboard.press("Escape");
  console.log("the address to sign in with carries the pin: yes");

  await page.evaluate(async () => {
    await window.zunaDesktop.notify({ title: "Zuna smoke test", body: "Notifications work", route: { serverId: "", key: "" } });
    await window.zunaDesktop.setBadge(3);
    await window.zunaDesktop.setBadge(0);
  });
  console.log("notification and badge calls succeeded");

  // Everything local must survive a restart, unlocked by the OS keychain.
  await electronApp.close();
  electronApp = await electron.launch(launchOptions);
  const second = await electronApp.firstWindow();
  second.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  await second.getByText("Saved messages").first().waitFor({ timeout: 30_000 });
  await second.getByText("Saved messages").first().click();
  await second.locator(".code-block").waitFor({ timeout: 20_000 });
  await second.waitForTimeout(400);
  await second.screenshot({ path: join(shots, "4-after-restart.png") });
  console.log("history survived a restart");

  if (errors.length > 0) throw new Error(`errors in the page:\n${errors.join("\n")}`);
  console.log(`SMOKE TEST PASSED. Screenshots: ${shots}`);
} catch (error) {
  console.error("SMOKE TEST FAILED:", error);
  console.error(errors.join("\n"));
  process.exitCode = 1;
} finally {
  await electronApp?.close().catch(() => undefined);
  server.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (const dir of [data, userData]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold files open for a moment after the app exits.
    }
  }
}
