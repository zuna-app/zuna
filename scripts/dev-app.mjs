// Updates this checkout, rebuilds whatever changed, and opens a development build
// of the app with live reload. Its data lives in .dev-data, so it never mixes with
// an installed copy of Zuna. Anything passed to this script goes to Electron.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { devAppData, devServerRunning, devWorldFile, ensureBuilt, ensureNativeScreenCurrent, env, pullLatest, root } from "./lib.mjs";

pullLatest();
ensureBuilt();
ensureNativeScreenCurrent();

const appEnv = { ...env };
if (existsSync(devWorldFile)) {
  // The sign-in form starts filled in, so signing in to the test server takes one click.
  const world = JSON.parse(readFileSync(devWorldFile, "utf8"));
  appEnv.RENDERER_VITE_DEV_SERVER = world.url;
  appEnv.RENDERER_VITE_DEV_USERNAME = world.username;
  appEnv.RENDERER_VITE_DEV_PASSWORD = world.password;
}
if (!(await devServerRunning())) {
  console.log("The test server isn't running. Start it with: npm run dev:server\n");
}

const result = spawnSync(
  process.execPath,
  [join(root, "node_modules", "electron-vite", "bin", "electron-vite.js"), "dev", "--", `--user-data-dir=${devAppData}`, ...process.argv.slice(2)],
  { cwd: join(root, "apps", "desktop-electron-legacy"), env: appEnv, stdio: "inherit" },
);
process.exit(result.status ?? 0);
