// A plugin's package and the marketplace's index, as the app reads them: the layout a
// package may have, what a package's and an index's signatures cover, and the index's shape.
// apps/desktop/src/plugins/package.rs, trust.rs and market.rs hold the app's side of each,
// and refuse what this would refuse.

import { createHash } from "node:crypto";
import { checkManifest, MAX_PACKAGE } from "../src/manifest.ts";
import * as hybrid from "./hybrid.mjs";
import { readZip, writeZip } from "./zip.mjs";

/** What a package's signature starts with, which nothing else Zuna signs does. */
export const PACKAGE_LABEL = "zuna-plugin-package/v1\n";
/** What an index's signature starts with. */
export const INDEX_LABEL = "zuna-plugin-index/v1\n";
/** The most files a package holds, and how deep under assets/ one may be. */
export const MAX_FILES = 200;
const MAX_DEPTH = 6;

/** Why a path can't be in a package, or null if it can. @param {string} name */
export function badPath(name) {
  if (name === "plugin.json" || name === "main.js" || name === "signature") return null;
  if (!name.startsWith("assets/")) return `${name} is outside the layout: plugin.json, main.js, assets/ and signature.`;
  const parts = name.split("/");
  if (parts.length > MAX_DEPTH + 1) return `${name} is too deep under assets/.`;
  if (parts.some((part) => part === "" || part === "." || part === "..")) return `${name} isn't a plain path.`;
  if (!/^[A-Za-z0-9_.\/-]+$/.test(name)) return `${name} has characters a package's paths don't.`;
  return null;
}

/** @param {Uint8Array} bytes */
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** What a package's signature covers: the label, then each file's hash and path, by path. @param {Map<string, Uint8Array>} files */
export function signedPackage(files) {
  const names = [...files.keys()].filter((name) => name !== "signature").sort();
  return Buffer.from(PACKAGE_LABEL + names.map((name) => `${sha256(/** @type {Uint8Array} */ (files.get(name)))} ${name}\n`).join(""), "utf8");
}

/** Everything wrong with a package's files, and its manifest when it parses. @param {Map<string, Uint8Array>} files */
export function checkFiles(files) {
  /** @type {string[]} */
  const problems = [];
  if (files.size > MAX_FILES) problems.push(`A package holds at most ${MAX_FILES} files.`);
  let total = 0;
  for (const [name, data] of files) {
    const bad = badPath(name);
    if (bad) problems.push(bad);
    total += data.length;
  }
  if (total > MAX_PACKAGE) problems.push("A package is at most 8 MB unpacked.");
  const raw = files.get("plugin.json");
  /** @type {any} */
  let manifest = null;
  if (!raw) problems.push("A package has a plugin.json.");
  else {
    try {
      manifest = JSON.parse(Buffer.from(raw).toString("utf8"));
      problems.push(...checkManifest(manifest));
    } catch {
      problems.push("plugin.json isn't JSON.");
    }
  }
  if (manifest?.main && !files.has("main.js")) problems.push("The manifest names main.js, and the package has none.");
  if (manifest && !manifest.main && files.has("main.js")) problems.push("The package has a main.js the manifest doesn't name.");
  if (manifest?.icon && !files.has(manifest.icon)) problems.push(`The manifest's icon, ${manifest.icon}, isn't in the package.`);
  return { problems, manifest };
}

/** A package of these files, signed with `secret` when given. @param {Map<string, Uint8Array>} files @param {Uint8Array | null} secret */
export function makePackage(files, secret) {
  const all = new Map(files);
  all.delete("signature");
  if (secret) all.set("signature", Buffer.from(hybrid.sign(secret, signedPackage(all)).toString("base64") + "\n", "utf8"));
  const order = ["plugin.json", "main.js", ...[...all.keys()].filter((n) => n.startsWith("assets/")).sort(), "signature"];
  return writeZip(order.filter((name) => all.has(name)).map((name) => ({ name, data: /** @type {Uint8Array} */ (all.get(name)) })));
}

/** A package's files, and whose key signed it, among `keys`, or null. @param {Uint8Array} zip @param {Uint8Array[]} keys */
export function openPackage(zip, keys = []) {
  if (zip.length > MAX_PACKAGE) throw new Error("A package is at most 8 MB.");
  const files = readZip(zip);
  const signature = files.get("signature");
  let signedBy = null;
  if (signature) {
    const bytes = Buffer.from(Buffer.from(signature).toString("utf8").trim(), "base64");
    const message = signedPackage(files);
    signedBy = keys.find((key) => hybrid.verify(key, message, bytes)) ?? null;
  }
  return { files, signedBy };
}

/** The index's signature, as index.json.sig holds it. @param {Uint8Array} index @param {Uint8Array} secret */
export function signIndex(index, secret) {
  return hybrid.sign(secret, Buffer.concat([Buffer.from(INDEX_LABEL, "utf8"), Buffer.from(index)])).toString("base64") + "\n";
}

/** Whether `signature` is one of `keys`'s on this index. @param {Uint8Array} index @param {string} signature @param {Uint8Array[]} keys */
export function indexSigned(index, signature, keys) {
  const message = Buffer.concat([Buffer.from(INDEX_LABEL, "utf8"), Buffer.from(index)]);
  const bytes = Buffer.from(signature.trim(), "base64");
  return keys.some((key) => hybrid.verify(key, message, bytes));
}
