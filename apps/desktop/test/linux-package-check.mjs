// Checks the AppImage and the .tar.gz that `npm run dist:linux` makes, in a KWin of its own:
// each starts and opens its window, and writes this person's zuna.desktop pointing at
// itself, as an AppImage or a .tar.gz has no package to install one, with its icon beside it.
// The .tar.gz, started after the AppImage, points the same file at itself.
//
//   npm run dist:linux && node apps/desktop/test/linux-package-check.mjs [screenshot-dir]

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { inside, outside, root, sleep, until } from "./linux-session.mjs";

await outside(import.meta.url);
const { work, xdg, session, check, start, shot, startKeyring, startDriver, finish } = await inside({ shots: process.argv[2] });

let failed;
try {
  const packages = join(root, "dist", "linux", "packages");
  const image = readdirSync(packages).find((name) => name.endsWith(".AppImage"));
  const archive = readdirSync(packages).find((name) => name.endsWith(".tar.gz"));
  if (!image || !archive) throw new Error("No AppImage or .tar.gz: run npm run dist:linux first.");
  const unpacked = mkdtempSync(join(work, "tar-"));
  spawnSync("tar", ["-xzf", join(packages, archive), "-C", unpacked], { stdio: "inherit" });
  const fromArchive = join(unpacked, readdirSync(unpacked)[0], "zuna");

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
  }
} catch (caught) {
  failed = caught;
}
await finish(failed);
