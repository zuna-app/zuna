// What scripts/ios-dist.mjs and scripts/macos-dist.mjs share to sign a release: running Apple's
// tools, a keychain of the run's own holding a certificate from a .p12, and the GitHub environment
// whose secrets they're kept in. Nothing here needs an npm install, so the jobs in
// .github/workflows/release.yml that hold those secrets run nothing from npm.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { env, root } from "./lib.mjs";
import { REPOSITORY } from "./release.mjs";

/** A failure that's said in plain words, and needs no stack. */
export class Failure extends Error {}
export const fail = (message) => {
  throw new Failure(message);
};

/** Runs a command where its output shows. */
export function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit", ...options });
  if (result.error) fail(`${command} couldn't start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed.`);
}

/** Runs a command quietly and returns what it printed. A secret one's arguments stay out of any message. */
export function read(command, args, { input, secret = false } = {}) {
  const result = spawnSync(command, args, { cwd: root, env, input, encoding: "utf8", maxBuffer: 256 << 20 });
  if (result.error) fail(`${command} couldn't start: ${result.error.message}`);
  if (result.status !== 0) fail(`${secret ? command : `${command} ${args.join(" ")}`} failed:\n${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

/** One value of a property list, from a file or its text, as text. Undefined when it isn't there. */
export function field(path, key, input) {
  const result = spawnSync("plutil", ["-extract", key, "raw", "-o", "-", input === undefined ? path : "-"], { input, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export const plistOf = (path) => JSON.parse(read("plutil", ["-convert", "json", "-o", "-", path]));

/** A property list's XML, of strings, booleans, arrays and objects. */
export function plist(value) {
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const write = (item, indent) => {
    if (typeof item === "boolean") return `${indent}<${item}/>`;
    if (typeof item === "string") return `${indent}<string>${escape(item)}</string>`;
    if (Array.isArray(item)) return `${indent}<array>\n${item.map((each) => write(each, `${indent}  `)).join("\n")}\n${indent}</array>`;
    const entries = Object.entries(item).map(([key, each]) => `${indent}  <key>${escape(key)}</key>\n${write(each, `${indent}  `)}`);
    return `${indent}<dict>\n${entries.join("\n")}\n${indent}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${write(value, "")}\n</plist>\n`;
}

/**
 * A keychain of the run's own, in `work`, holding a certificate of a kind, such as "Apple
 * Distribution", and its private key, from a .p12, which codesign may use without asking.
 */
export function keychainWith(work, p12, password, kind) {
  const keychain = join(work, "signing.keychain-db");
  const unlock = randomBytes(32).toString("hex");
  read("security", ["create-keychain", "-p", unlock, keychain], { secret: true });
  const remove = () => spawnSync("security", ["delete-keychain", keychain]);
  try {
    read("security", ["set-keychain-settings", "-lut", "3600", keychain]);
    read("security", ["unlock-keychain", "-p", unlock, keychain], { secret: true });
    const file = join(work, "certificate.p12");
    writeFileSync(file, p12, { mode: 0o600 });
    try {
      read("security", ["import", file, "-k", keychain, "-f", "pkcs12", "-P", password, "-T", "/usr/bin/codesign", "-T", "/usr/bin/security"], { secret: true });
    } finally {
      rmSync(file, { force: true });
    }
    read("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", unlock, keychain], { secret: true });
    const listed = read("security", ["find-identity", "-v", "-p", "codesigning", keychain]);
    const identity = listed.split("\n").map((line) => /^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"/.exec(line)).find((match) => match?.[2].startsWith(`${kind}: `));
    if (!identity) fail(`The .p12 holds no valid ${kind} identity. It needs the certificate with its private key, as Xcode or Keychain Access exports it.`);
    return { keychain, certificate: identity[1], identity: identity[2], remove };
  } catch (error) {
    remove();
    throw error;
  }
}

/** Puts a keychain first where codesign and Xcode look, and gives what puts the list back. */
export function searchFirst(keychain) {
  const before = read("security", ["list-keychains", "-d", "user"]).split("\n").map((line) => line.trim().replace(/^"|"$/g, "")).filter(Boolean);
  read("security", ["list-keychains", "-d", "user", "-s", keychain, ...before]);
  return () => spawnSync("security", ["list-keychains", "-d", "user", "-s", ...before]);
}

/** Fails unless each of an environment's secrets is set, as a job running in it gets them. */
export function needSecrets(names, environment, docs) {
  const missing = names.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) fail(`${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} set. They're the ${environment} environment's secrets: ${docs}.`);
}

/** The folder and the issuer ID of a `secrets` command's arguments: `<folder> --issuer <id>`. */
export function folderAndIssuer(args, usage) {
  const at = args.indexOf("--issuer");
  const issuer = at >= 0 ? args[at + 1] : undefined;
  const folder = args.find((arg, index) => !arg.startsWith("--") && index !== at + 1);
  if (!folder || !issuer) fail(usage);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(issuer)) fail(`"${issuer}" isn't an issuer ID. It's above the list of keys in App Store Connect, under Integrations.`);
  if (!process.stdin.isTTY) fail("Run it in a terminal: it asks for the certificate's password.");
  const dir = resolve(folder);
  return { dir, issuer, files: readdirSync(dir) };
}

/** The one file in a folder's list that a test picks, or a failure saying what's there instead. */
export function one(dir, files, what, test) {
  const found = files.filter(test);
  if (found.length !== 1) fail(`${dir} should hold one ${what}, and holds ${found.length === 0 ? "none" : found.join(", ")}.`);
  return join(dir, found[0]);
}

/** An App Store Connect key's file, its ID from the name Apple gives it, and its text. */
export function connectKey(file) {
  const id = /^AuthKey_([A-Z0-9]+)\.p8$/.exec(basename(file))?.[1];
  if (!id) fail(`${basename(file)} isn't named as App Store Connect names a key, AuthKey_<ID>.p8.`);
  return { id, text: readFileSync(file, "utf8").trim() };
}

/** Asks for a line without showing it. */
export function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin } = process;
    let value = "";
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") process.exit(130);
        if (char === "\r" || char === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        value = char === "\u007f" ? value.slice(0, -1) : value + char;
      }
    };
    stdin.on("data", onData);
  });
}

/**
 * Makes a GitHub environment if it isn't there, and holds it to tags named so either way, as
 * GitHub makes one with no rule by itself the first time a job names it. Fails if another rule
 * lets more reach it.
 */
export function holdEnvironment(environment, tags) {
  const path = `repos/${REPOSITORY}/environments/${environment}`;
  const found = spawnSync("gh", ["api", path, "--jq", ".deployment_branch_policy.custom_branch_policies"], { encoding: "utf8" });
  if (found.status !== 0 && !/HTTP 404/.test(found.stderr)) fail(`gh couldn't read the ${environment} environment:\n${found.stderr.trim()}`);
  if (found.status !== 0 || found.stdout.trim() !== "true") {
    read("gh", ["api", "-X", "PUT", path, "-F", "deployment_branch_policy[protected_branches]=false", "-F", "deployment_branch_policy[custom_branch_policies]=true"]);
  }
  const rules = read("gh", ["api", `${path}/deployment-branch-policies`, "--jq", '.branch_policies[] | "\\(.type) \\(.name)"']).split(/\r?\n/);
  if (!rules.includes(`tag ${tags}`)) read("gh", ["api", "-X", "POST", `${path}/deployment-branch-policies`, "-f", `name=${tags}`, "-f", "type=tag"]);
  const others = rules.filter((rule) => rule && rule !== `tag ${tags}`);
  if (others.length > 0) fail(`The ${environment} environment also lets ${others.join(", ")} reach it. Remove ${others.length === 1 ? "that rule" : "those rules"} in the repository's settings, then run this again.`);
  console.log(`The ${environment} environment of ${REPOSITORY} is there, and only tags named ${tags} reach it.`);
}

/** Sets an environment's secrets with gh, each from its value, showing none of them. */
export function setSecrets(environment, values) {
  for (const [name, value] of Object.entries(values)) {
    const set = spawnSync("gh", ["secret", "set", name, "--env", environment, "--repo", REPOSITORY], { input: value, encoding: "utf8", stdio: ["pipe", "inherit", "inherit"] });
    if (set.status !== 0) fail(`gh couldn't set ${name}. The ones before it are set: run this again once it can.`);
  }
}

/** Runs a script's command, saying a Failure in plain words. */
export async function main(commands, [command, ...args]) {
  if (!commands[command]) {
    console.error(`There's no command "${command ?? ""}" here. It takes ${Object.keys(commands).join(", ")}.`);
    process.exit(1);
  }
  try {
    await commands[command](args);
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    console.error(error.message);
    process.exit(1);
  }
}
