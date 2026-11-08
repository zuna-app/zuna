// Builds the Go server the tests run against, into the system's temporary folder.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const goBin = [join(process.env.LOCALAPPDATA ?? "", "Programs", "go", "bin"), join(homedir(), "go", "bin")].filter(existsSync);

/** Built without debug symbols, which Windows Defender takes for a trojan's. */
export function buildServer(): string {
  const out = join(tmpdir(), `zuna-test-server${process.platform === "win32" ? ".exe" : ""}`);
  execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "./cmd/zuna-server"], {
    cwd: join(root, "server"),
    env: { ...process.env, PATH: [...goBin, process.env.PATH ?? process.env.Path ?? ""].join(delimiter) },
    stdio: "inherit",
  });
  return out;
}
