// Runs the test suites with coverage, each writing its report under coverage/, which the Coverage workflow sends to
// Codecov with the suite's name as its flag. Names the suites to run, or runs them all:
//   node scripts/coverage.mjs [server] [crypto] [core] [watch] [bot]
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { root, run } from "./lib.mjs";

const out = join(root, "coverage");

const SUITES = {
  // Every package's statements, whichever package's tests reach them, as the API's tests drive the store.
  server: () => run("go", ["test", "-covermode=atomic", "-coverpkg=./...", `-coverprofile=${join(out, "server.out")}`, "./..."], { cwd: join(root, "server") }),
  // Natively, as cargo-llvm-cov can't measure WebAssembly. Needs `cargo install cargo-llvm-cov` and the
  // llvm-tools-preview component.
  crypto: () => run("cargo", ["llvm-cov", "--lib", "--lcov", "--output-path", join(out, "crypto.lcov")], { cwd: join(root, "crypto") }),
  core: () => vitest("packages/core"),
  watch: () => vitest("packages/watch"),
  bot: () => vitest("apps/bot"),
};

/** The workspace's `npm test`, which is `vitest run`, with coverage. */
function vitest(dir) {
  run(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--coverage"], { cwd: join(root, dir) });
}

const asked = process.argv.slice(2);
const unknown = asked.filter((name) => !(name in SUITES));
if (unknown.length > 0) {
  console.error(`No suite named ${unknown.join(", ")}. The suites are ${Object.keys(SUITES).join(", ")}.`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
for (const name of asked.length > 0 ? asked : Object.keys(SUITES)) {
  rmSync(join(out, name), { recursive: true, force: true });
  SUITES[name]();
}
