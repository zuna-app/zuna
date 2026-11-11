// Checks the AppImage and the .tar.gz that `npm run dist:linux` makes, in a KWin of its own:
// each starts and opens its window, and writes this person's zuna.desktop pointing at
// itself, as an AppImage or a .tar.gz has no package to install one, with its icon beside it.
// The .tar.gz, started after the AppImage, points the same file at itself. Each carries
// zuna-watch beside the app, the window a video watched together plays in, which opens the
// page it's given and says it's ready.
//
//   npm run dist:linux && node apps/desktop/test/linux-package-check.mjs [screenshot-dir]

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { inside, outside, root, sleep, until } from "./linux-session.mjs";

await outside(import.meta.url);
const { work, xdg, session, check, start, shot, startKeyring, startDriver, finish } = await inside({ shots: process.argv[2] });

/** Starts a zuna-watch with a page of nothing but a script that says it's ready, and says whether it did. */
async function watchWindowStarts(program, env) {
  const child = spawn(program, [], { env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stderr.on("data", (data) => (output += data));
  const ready = new Promise((resolve) => {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.includes('\\"ready\\"')) resolve(true);
    });
    child.on("exit", () => resolve(false));
    setTimeout(() => resolve(false), 20_000).unref();
  });
  const page = `<!doctype html><script>window.webkit.messageHandlers.zuna.postMessage(JSON.stringify({ type: "ready" }))</script>`;
  child.stdin.write(`${JSON.stringify({ type: "load", page, origin: "https://chat.zuna.desktop/", title: "Watch check" })}\n`);
  const started = await ready;
  child.stdin.end();
  await sleep(1000);
  if (child.exitCode === null) child.kill();
  return { started, output: output.trim().split("\n").slice(-3).join(" | ") };
}

let failed;
try {
  const packages = join(root, "dist", "linux", "packages");
  const image = readdirSync(packages).find((name) => name.endsWith(".AppImage"));
  const archive = readdirSync(packages).find((name) => name.endsWith(".tar.gz"));
  if (!image || !archive) throw new Error("No AppImage or .tar.gz: run npm run dist:linux first.");
  const unpacked = mkdtempSync(join(work, "tar-"));
  spawnSync("tar", ["-xzf", join(packages, archive), "-C", unpacked], { stdio: "inherit" });
  const fromArchive = join(unpacked, readdirSync(unpacked)[0], "zuna");
  // What the AppImage holds, as its runtime mounts it, taken out with the runtime's own option.
  const extracted = mkdtempSync(join(work, "appimage-"));
  spawnSync(join(packages, image), ["--appimage-extract", "usr/lib/zuna/zuna-watch"], { cwd: extracted, stdio: "ignore" });
  const watchIn = { AppImage: join(extracted, "squashfs-root", "usr", "lib", "zuna", "zuna-watch"), "tar.gz": join(fromArchive, "..", "zuna-watch") };

  // The check's session has its own for the portals, which the app would leave alone as someone else's.
  const entry = join(xdg.XDG_DATA_HOME, "applications", "zuna.desktop");
  rmSync(entry, { force: true });
  // A Secret Service for the device key, without which the app waits two minutes for one.
  check("the check's own keyring holds the Secret Service's name", await startKeyring());
  const { windowOf } = await startDriver();

  for (const [kind, program] of [["AppImage", join(packages, image)], ["tar.gz", fromArchive]]) {
    const app = start(program, [], { ...session, ZUNA_DATA_DIR: join(work, `data-${kind}`), RUST_LOG: "warn" }, kind);
    const window = await until(windowOf, `the ${kind}'s window`, 30_000).catch(() => null);
    check(`the ${kind} starts and opens its window`, !!window, window ? `${window.width}x${window.height}` : app.output.slice(-300));
    const written = await until(() => existsSync(entry) && readFileSync(entry, "utf8").includes(program) && readFileSync(entry, "utf8"), `the ${kind}'s .desktop file`, 10_000).catch(() => "");
    const exec = written.split("\n").find((line) => line.startsWith("Exec="));
    check(`it writes its own zuna.desktop, pointing at itself`, !!exec && exec.includes(program) && written.includes("X-Zuna-Written-By-Itself=true"), exec ?? "none");
    const validated = spawnSync("desktop-file-validate", [entry], { encoding: "utf8" });
    check("which desktop-file-validate takes", validated.status === 0, `${validated.stdout}${validated.stderr}`.trim());
    const icon = written.split("\n").find((line) => line.startsWith("Icon="))?.slice(5);
    check("with its icon beside it", !!icon && existsSync(icon), icon ?? "none");
    await shot(`01-${kind}`);
    app.kill();
    await sleep(1500);
    const helper = watchIn[kind];
    let runnable = false;
    try {
      accessSync(helper, constants.X_OK);
      runnable = true;
    } catch {}
    check(`zuna-watch is beside the ${kind}'s app`, runnable, helper);
    if (runnable) {
      const { started, output } = await watchWindowStarts(helper, { ...session, GDK_BACKEND: "wayland" });
      check("and opens its window with the page it's given", started, output);
    }
  }
} catch (caught) {
  failed = caught;
}
await finish(failed);
