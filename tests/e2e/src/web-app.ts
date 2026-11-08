// The web app as the other side of a check, in Chromium: the built app (npm run build -w
// @zuna/web), served by a zuna-web of its own on this machine, with Chromium's fake camera and
// microphone, which says `speech` where it's given.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { root } from "./paths";

export interface WebApp {
  context: BrowserContext;
  page: Page;
  /** Where the app is, for `page.goto` once the page's init scripts are in. */
  url: string;
  close(): Promise<void>;
}

const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);

export async function startWebApp(options: { name: string; speech?: string }): Promise<WebApp> {
  const dist = join(root, "apps", "web", "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("Build the web app first: npm run build -w @zuna/web");
  const bin = mkdtempSync(join(tmpdir(), "zuna-e2e-web-"));
  const host = join(bin, "zuna-web");
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", host, "./cmd/zuna-web"], {
    cwd: join(root, "server"),
    env: { ...process.env, PATH: [...goBin, process.env.PATH ?? ""].join(delimiter) },
    stdio: "inherit",
  });
  const port = 21000 + Math.floor(Math.random() * 20000);
  const served = spawn(host, ["--listen", `127.0.0.1:${port}`, "--root", dist, "--dev"], { stdio: ["ignore", "pipe", "pipe"] });
  let said = "";
  served.stdout!.on("data", (chunk) => (said += chunk));
  served.stderr!.on("data", (chunk) => (said += chunk));
  for (let waited = 0; !said.includes("Listening on"); waited += 100) {
    if (waited > 15_000 || served.exitCode !== null) throw new Error(`zuna-web didn't start: ${said}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // localhost, which a browser counts as secure, for the camera and the microphone.
  const url = `http://localhost:${port}/`;
  const profile = mkdtempSync(join(tmpdir(), `zuna-e2e-${options.name}-`));
  const context = await chromium.launchPersistentContext(profile, {
    viewport: { width: 1280, height: 832 },
    // Without the sandbox, as macOS's keeps the audio service from opening the speech, and the fake device sends silence.
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      ...(options.speech ? [`--use-file-for-fake-audio-capture=${options.speech}`] : []),
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
  });
  await context.grantPermissions(["microphone", "camera", "notifications"], { origin: url.slice(0, -1) });
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    context,
    page,
    url,
    async close() {
      await context.close().catch(() => undefined);
      served.kill();
      rmSync(profile, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    },
  };
}
