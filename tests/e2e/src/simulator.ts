// The dedicated simulator the end-to-end tests use, and the app installed on it.
// Tests never touch any other simulator.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { root } from "./paths";

export const SIMULATOR_NAME = process.env.ZUNA_E2E_SIMULATOR ?? "Zuna E2E iPhone";
export const BUNDLE_ID = "chat.zuna.app";
const projectDir = join(root, "apps", "ios");
const derivedData = join(projectDir, "build", "DerivedData");
export const appPath = join(derivedData, "Build", "Products", "Debug-iphonesimulator", "Zuna.app");

const simctl = (...args: string[]) => execFileSync("xcrun", ["simctl", ...args], { encoding: "utf8" });

/** The simulator's UDID, creating it (iPhone 17 or the newest plain iPhone, or an iPad Pro, on the newest iOS runtime that runs it) if it doesn't exist. */
export function simulatorId(): string {
  const devices = JSON.parse(simctl("list", "devices", "--json")).devices as Record<string, { name: string; udid: string }[]>;
  for (const list of Object.values(devices)) {
    const match = list.find((device) => device.name === SIMULATOR_NAME);
    if (match) return match.udid;
  }
  // CI machines may have an older Xcode without the iPhone 17. A name with "iPad" in it gets an iPad.
  const types = JSON.parse(simctl("list", "devicetypes", "--json")).devicetypes as { identifier: string; name: string }[];
  const type = SIMULATOR_NAME.includes("iPad")
    ? types.filter((item) => /^iPad Pro 11-inch/.test(item.name)).at(-1) ?? types.filter((item) => item.name.startsWith("iPad")).at(-1)!
    : types.find((item) => item.identifier.endsWith(".iPhone-17")) ?? types.filter((item) => /^iPhone \d+$/.test(item.name)).at(-1)!;
  // The newest runtime that runs it: a point release may only cover a new device.
  const runtimes = JSON.parse(simctl("list", "runtimes", "--json")).runtimes as {
    identifier: string;
    platform: string;
    isAvailable: boolean;
    supportedDeviceTypes?: { identifier: string }[];
  }[];
  const runtime = runtimes
    .filter((item) => item.platform === "iOS" && item.isAvailable)
    .filter((item) => item.supportedDeviceTypes?.some((supported) => supported.identifier === type.identifier) ?? true)
    .at(-1)!;
  return simctl("create", SIMULATOR_NAME, type.identifier, runtime.identifier).trim();
}

export function boot(udid: string): void {
  const state = JSON.parse(simctl("list", "devices", "--json")).devices;
  const booted = Object.values(state as Record<string, { udid: string; state: string }[]>)
    .flat()
    .some((device) => device.udid === udid && device.state === "Booted");
  if (!booted) simctl("boot", udid);
  simctl("bootstatus", udid, "-b");
}

/** Builds the Debug app for the simulator. */
export function buildApp(): void {
  execFileSync("xcodegen", ["generate", "--spec", "project.yml", "--quiet"], { cwd: projectDir, stdio: "inherit" });
  execFileSync(
    "xcodebuild",
    [
      "-project", "Zuna.xcodeproj",
      "-scheme", "Zuna",
      "-configuration", "Debug",
      "-destination", `id=${simulatorId()}`,
      "-derivedDataPath", derivedData,
      "-quiet",
      "build",
    ],
    { cwd: projectDir, stdio: ["ignore", "ignore", "inherit"] },
  );
  if (!existsSync(appPath)) throw new Error(`the app wasn't built at ${appPath}`);
}

/** A clean install: no app data and no Keychain items from earlier runs. */
export function installFresh(udid: string): void {
  try {
    simctl("uninstall", udid, BUNDLE_ID);
  } catch {
    // Not installed yet.
  }
  // The simulator's keychain outlives uninstalling, unlike a real device's.
  simctl("keychain", udid, "reset");
  simctl("install", udid, appPath);
}

export function launch(udid: string, args: string[]): void {
  simctl("launch", "--terminate-running-process", udid, BUNDLE_ID, ...args);
}

export function terminate(udid: string): void {
  try {
    simctl("terminate", udid, BUNDLE_ID);
  } catch {
    // Not running.
  }
}
