// Smoke test of the production build in real Electron: sandbox, custom protocol,
// content security policy, OS keychain, encrypted storage, and a real server.
//
//   npm run build -w @zuna/desktop && node apps/desktop/test/smoke.mjs [screenshot-dir]
//
// Set ZUNA_APP to a packaged executable to test an installed build instead.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const url = `http://127.0.0.1:${port}`;
const server = spawn(binary, ["--listen", `127.0.0.1:${port}`, "--data", data, "--public-url", url], { stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", (chunk) => (output += chunk));
server.stderr.on("data", (chunk) => (output += chunk));

async function setupLink() {
  for (let i = 0; i < 200; i++) {
    const match = output.match(/http:\/\/\S+\/invite\/\S+/);
    if (match) return match[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the server didn't start:\n${output}`);
}

const packaged = process.env.ZUNA_APP;
const launchOptions = {
  ...(packaged ? { executablePath: packaged, args: [`--user-data-dir=${userData}`] } : { args: [app, `--user-data-dir=${userData}`] }),
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

  await page.getByLabel("Invite link").fill(link, { timeout: 30_000 });
  await page.screenshot({ path: join(shots, "1-welcome.png") });
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByPlaceholder("How people will see you").fill("Smoke Tester", { timeout: 15_000 });
  await page.locator('input[type="password"]').fill("smoke-test-only-Pass-9182");
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

  await page.evaluate(async () => {
    await window.zunaDesktop.notify({ title: "Zuna smoke test", body: "Notifications work", route: {} });
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
