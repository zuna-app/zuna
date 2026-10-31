// Builds what the tests run before any of them start: the core bundle, the
// headless iOS host and, with ZUNA_E2E_TARGET=simulator, the app itself on a
// clean install in the E2E simulator. The builds are incremental.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { root } from "./paths";
import { boot, buildApp, installFresh, simulatorId } from "./simulator";

export default function setup(): void {
  execFileSync(process.execPath, [join(root, "apps", "ios", "core-bundle", "build.mjs")], { stdio: "inherit" });
  execFileSync("swift", ["build", "--package-path", join(root, "apps", "ios", "ZunaKit"), "--product", "zuna-host"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (process.env.ZUNA_E2E_TARGET === "simulator") {
    const udid = simulatorId();
    buildApp();
    boot(udid);
    installFresh(udid);
  }
}
