// The quick checks for the iOS app, run before anything slower (see
// docs/IOS_TESTING.md): types and warnings (L0), the encryption core natively
// and against the WebAssembly build (L1), and the host's units (L2). Needs
// `npm run build:ios` and `npm run build:crypto` to have run once.

import { join } from "node:path";
import { root, run } from "./lib.mjs";

const iosDir = join(root, "apps", "ios");
const started = Date.now();
const step = (name) => console.log(`\n=== ${name} (${Math.round((Date.now() - started) / 1000)}s)`);

step("L0: TypeScript");
run("npm", ["run", "typecheck"]);
run("npm", ["run", "typecheck", "-w", "@zuna/e2e"]);

step("L0: the app, with warnings as errors");
run(process.execPath, [join(iosDir, "core-bundle", "build.mjs")]);
run("xcodegen", ["generate", "--spec", "project.yml", "--quiet"], { cwd: iosDir });
run(
  "xcodebuild",
  [
    "-project", "Zuna.xcodeproj",
    "-scheme", "Zuna",
    "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", join(iosDir, "build", "Check"),
    "ARCHS=arm64",
    "ZUNA_WARNINGS_AS_ERRORS=YES",
    "-quiet",
    "build-for-testing",
  ],
  { cwd: iosDir },
);

step("L1: the Rust tests, natively");
run("cargo", ["test", "--lib"], { cwd: join(root, "crypto") });

step("L1 and L2: native against WebAssembly, and golden files from the desktop");
run("npm", ["run", "test", "-w", "@zuna/e2e", "--", "test/crypto.test.ts", "test/golden.test.ts"]);

step("L2: the host's units");
run("swift", ["test", "--package-path", join(iosDir, "ZunaKit")]);

step("all checks passed");
