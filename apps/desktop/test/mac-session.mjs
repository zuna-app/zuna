// What the checks of the native app on macOS share: building its bundle with the test control
// (src/test_control.rs), a test server, starting the app as macOS starts one, with `open`, in
// a data folder of its own, and driving it over its socket: clicks, typing and screenshots of
// its window, which GPUI draws again for them, so nothing is asked of the system and the
// person's own pointer is left alone. There's no compositor to nest on macOS, so the window
// opens on the person's desktop.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const here = dirname(fileURLToPath(import.meta.url));
export const crate = join(here, "..");
export const root = join(crate, "..", "..");
export const target = join(homedir(), "Library", "Caches", "zuna-desktop-target");
export const app = join(target, "debug", "Zuna Dev.app");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function until(condition, what, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Builds the app's bundle with the test control, and a test server. */
export function build() {
  if (process.platform !== "darwin") {
    console.log("This checks the native app on macOS.");
    process.exit(0);
  }
  execFileSync(process.execPath, [join(root, "scripts", "macos-app.mjs"), "bundle", "--test-control"], { stdio: "inherit", cwd: root });
  const server = join(tmpdir(), "zuna-mac-check-server");
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", server, "./cmd/zuna-server"], { stdio: "inherit", cwd: join(root, "server") });
  return { server };
}

/** A run's folder, what it starts, its checks and its screenshots. */
export function session({ shots } = {}) {
  const work = mkdtempSync(join(tmpdir(), "zuna-mac-check-"));
  const shotsDir = shots ?? join(work, "shots");
  mkdirSync(shotsDir, { recursive: true });
  const started = [];
  const sockets = [];
  const failures = [];

  function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
    if (!ok) failures.push(name);
  }

  function start(program, args, env, name, cwd) {
    const child = spawn(program, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    child.output = "";
    child.stdout.on("data", (data) => (child.output += data));
    child.stderr.on("data", (data) => (child.output += data));
    child.name = name;
    started.push(child);
    return child;
  }

  /** A test server, and its setup link for the owner's account. */
  async function startServer(binary, extra = []) {
    const port = 21000 + Math.floor(Math.random() * 20000);
    const url = `http://127.0.0.1:${port}`;
    const server = start(binary, ["--listen", `127.0.0.1:${port}`, "--data", join(work, "server"), "--public-url", url, "--auth-burst", "1000", ...extra], process.env, "server");
    const setupLink = await until(() => server.output.match(/http:\/\/\S+\/invite\/\S+/)?.[0], "the server's setup link");
    return { port, url, setupLink, server };
  }

  /**
   * The app, started as macOS starts it, with a data folder and a test control of its own.
   * What it writes goes to a log in the run's folder.
   */
  async function startApp(name = "app", env = {}) {
    const data = join(work, name);
    // A socket's address has to fit in 104 bytes, which the run's folder may not.
    const socket = join("/tmp", `zuna-mac-check-${process.pid}-${name}.sock`);
    rmSync(socket, { force: true });
    sockets.push(socket);
    const log = join(work, `${name}.log`);
    const pairs = { ZUNA_DATA_DIR: data, ZUNA_TEST_CONTROL: socket, RUST_LOG: process.env.RUST_LOG ?? "info", ...env };
    spawnSync("open", ["-n", "--stdout", log, "--stderr", log, ...Object.entries(pairs).flatMap(([key, value]) => ["--env", `${key}=${value}`]), app]);
    await until(() => existsSync(socket), "the app's test control", 60_000);
    const control = await connect(socket, name);
    control.log = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
    control.data = data;
    return control;
  }

  /** Talks to an app's test control: `send` a request, and get its answer. */
  async function connect(path, name) {
    const socket = await until(
      () =>
        new Promise((resolve) => {
          const attempt = createConnection(path);
          attempt.once("connect", () => resolve(attempt));
          attempt.once("error", () => resolve(null));
        }),
      "a connection to the test control",
      30_000,
    );
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
    let queue = Promise.resolve();
    // An app that stops answering fails the step after 30 seconds, rather than holding the
    // check, and its finish, for good.
    const send = (request) => {
      const answer = queue.then(async () => {
        socket.write(`${JSON.stringify(request)}\n`);
        const { value } = await Promise.race([lines.next(), new Promise((resolve) => setTimeout(() => resolve({ value: '{"error":"timed out"}' }), 30_000).unref())]);
        return JSON.parse(value ?? '{"error":"closed"}');
      });
      queue = answer.catch(() => {});
      return answer;
    };
    let counter = 0;
    return {
      send,
      click: (x, y, options = {}) => send({ click: [x, y], ...options }),
      key: (key) => send({ key }),
      type: (text) => send({ type: text }),
      core: (method, args = [], server) => send({ core: method, args, ...(server ? { server } : {}) }),
      state: async () => (await send({ state: true })).ok,
      shot: async (label) => {
        // Drawn once and given a moment, as what just appeared is still fading in, and the
        // system may not be drawing frames for the window at all.
        await send({ state: true });
        await sleep(500);
        counter += 1;
        const file = join(shotsDir, `${name}-${String(counter).padStart(2, "0")}-${label}.png`);
        const answer = await send({ shot: file });
        return answer.ok ? file : null;
      },
      quit: () => send({ quit: true }).catch(() => {}),
      close: () => socket.end(),
    };
  }

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    for (const child of started) child.kill();
    // The apps `open` started aren't its children: each is found by the test control's socket
    // it holds, and stopped, so none is left running after the check.
    for (const socket of sockets) {
      const holders = spawnSync("lsof", ["-t", socket], { encoding: "utf8" }).stdout ?? "";
      for (const pid of holders.split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid)) {
        try {
          process.kill(pid);
        } catch {
          // Gone already.
        }
      }
      rmSync(socket, { force: true });
    }
    // The run's folder goes, unless the screenshots are in it or something failed, when its
    // logs are worth reading.
    if (shots && !failures.length) rmSync(work, { recursive: true, force: true });
    if (failures.length) console.log(`logs in ${work}`);
    console.log(`\nscreenshots in ${shotsDir}`);
    if (failures.length) {
      console.log(`${failures.length} failed: ${failures.join("; ")}`);
      process.exitCode = 1;
    } else {
      console.log("all passed");
    }
  }

  // Stopped by hand, or by an error nothing caught: what was started goes all the same.
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      failures.push(`stopped by ${signal}`);
      finish();
      process.exit(1);
    });
  }
  process.once("uncaughtException", (error) => {
    failures.push(String(error));
    console.error(error);
    finish();
    process.exit(1);
  });

  return { work, shots: shotsDir, check, start, startServer, startApp, finish };
}
