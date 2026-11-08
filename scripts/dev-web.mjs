// Opens the web app for development, with live reload, at http://localhost:5174.
// A local zuna-web on port 8790 answers its /_zuna requests (link previews and the
// host's settings), and the sign-in form starts filled in for the test server.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { devData, devServerRunning, devWorldFile, ensureBuilt, env, root, run } from "./lib.mjs";

ensureBuilt();

const binary = join(devData, "bin", `zuna-web${process.platform === "win32" ? ".exe" : ""}`);
run("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", binary, "./cmd/zuna-web"], { cwd: join(root, "server") });

const appEnv = { ...env };
if (existsSync(devWorldFile)) {
  // The sign-in form starts filled in, so signing in to the test server takes one click.
  const world = JSON.parse(readFileSync(devWorldFile, "utf8"));
  appEnv.ZUNA_DEV_SERVER = world.url;
  appEnv.ZUNA_DEV_USERNAME = world.username;
  appEnv.ZUNA_DEV_PASSWORD = world.password;
}
if (!(await devServerRunning())) {
  console.log("The test server isn't running. Start it with: npm run dev:server\n");
}

const host = spawn(binary, ["--listen", "127.0.0.1:8790", "--dev"], { env, stdio: "inherit" });
const vite = spawn(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js")], {
  cwd: join(root, "apps", "web"),
  env: appEnv,
  stdio: "inherit",
});
const stop = () => {
  host.kill();
  vite.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
vite.on("exit", (code) => {
  host.kill();
  process.exit(code ?? 0);
});
// Without it every /_zuna request fails, so it doesn't carry on as if it were there.
host.on("exit", (code) => {
  if (code === null || code === 0) return;
  console.error("\nzuna-web stopped: is port 8790 in use?");
  vite.kill();
  process.exit(1);
});
