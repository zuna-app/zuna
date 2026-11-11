// Builds the iOS app in Release and checks that none of the test-only code made
// it in: the control server, the test hooks, the spikes and their launch
// arguments. Swift type names are mangled in a binary, so this looks for the
// string literals that only that code contains. scripts/ios-dist.mjs runs the
// same check on the archive that goes to TestFlight.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { root, run } from "./lib.mjs";

const forbidden = [
  "chat.zuna.control",
  "Control server listening",
  "ZunaControlPort",
  "ZunaBootSession",
  "ZunaResetData",
  "ZunaSuspendDelay",
  "ZunaSpike",
  "lockEntries",
  "crashOn",
  "testHooks",
  "attachFile",
  "ZunaPushToken",
  "ZunaAskForNotifications",
  "clearNotifications",
  "ZunaFakeCamera",
  "ZunaFakeScreen",
  "voipPush",
];

/** The test-only code a built Zuna.app holds, by the strings only that code has. Empty when there's none. */
export function testOnlyCode(app) {
  const binary = join(app, "Zuna");
  if (!existsSync(binary)) throw new Error(`no binary at ${binary}`);
  const found = existsSync(join(app, "Zuna.debug.dylib")) ? ["a debug dylib"] : [];
  const strings = execFileSync("strings", ["-a", binary], { encoding: "utf8", maxBuffer: 256 << 20 });
  return [...found, ...forbidden.filter((word) => strings.includes(word))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const iosDir = join(root, "apps", "ios");
  const derivedData = join(iosDir, "build", "ReleaseCheck");

  run(process.execPath, [join(iosDir, "core-bundle", "build.mjs")]);
  run("xcodegen", ["generate", "--spec", "project.yml", "--quiet"], { cwd: iosDir });
  run(
    "xcodebuild",
    ["-project", "Zuna.xcodeproj", "-scheme", "Zuna", "-configuration", "Release", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", derivedData, "ARCHS=arm64", "-quiet", "build"],
    { cwd: iosDir },
  );

  const found = testOnlyCode(join(derivedData, "Build", "Products", "Release-iphonesimulator", "Zuna.app"));
  if (found.length > 0) {
    console.error(`The Release app contains test-only code: ${found.join(", ")}`);
    process.exit(1);
  }
  console.log("The Release app contains no test-only code.");
}
