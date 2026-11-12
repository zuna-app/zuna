#!/usr/bin/env node
// zuna-plugin: makes, builds, packs, checks and signs a plugin for Zuna's native app, and
// builds the marketplace's signed index (docs/PLUGINS.md).
//
//   zuna-plugin init <dir> [--id <id>] [--name <name>]     a new plugin, ready to build
//   zuna-plugin build [dir]                                 bundles src/main.tsx into dist/main.js
//   zuna-plugin pack [dir] [--out <dir>] [--key <file>]     builds, then makes <id>-<version>.zunaplugin
//   zuna-plugin check <dir | file> [--public <base64>]      says what's wrong, and what it asks for
//   zuna-plugin keygen --out <file>                         a new plugin signing key; prints its public half
//   zuna-plugin public <file>                               a signing key's public half
//   zuna-plugin sign <file> --key <file>                    signs a package
//   zuna-plugin index --packages <dir> --out <dir> --key <file> [--previous <index.json>] [--revoked <file>]
//                                                           the marketplace's index.json and index.json.sig

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PERMISSIONS } from "../src/manifest.ts";
import * as hybrid from "./hybrid.mjs";
import { checkFiles, indexSigned, makePackage, openPackage, sha256, signIndex } from "./package.mjs";

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string[]} argv */
function parse(argv) {
  /** @type {string[]} */
  const positional = [];
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const next = argv[i + 1];
      flags[arg.slice(2)] = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
    } else positional.push(arg);
  }
  return { positional, flags };
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`zuna-plugin: ${message}`);
  process.exit(1);
}

/** @param {string} dir */
function readManifest(dir) {
  const path = join(dir, "plugin.json");
  if (!existsSync(path)) fail(`${dir} has no plugin.json.`);
  return { raw: readFileSync(path), manifest: JSON.parse(readFileSync(path, "utf8")) };
}

/** Every file under a folder, by its path from `root`. @param {string} root @param {string} dir */
function walk(root, dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(root, path));
    else out.push(relative(root, path).split("\\").join("/"));
  }
  return out;
}

/** Bundles a plugin's script, as the app runs it: one file, ES2022, with the SDK in it. @param {string} dir */
export async function build(dir) {
  const { manifest } = readManifest(dir);
  if (!manifest.main) return null;
  const entry = ["src/main.tsx", "src/main.ts", "src/main.jsx", "src/main.js"].map((file) => join(dir, file)).find((file) => existsSync(file));
  // A script written by hand beside the manifest goes as it is.
  if (!entry && existsSync(join(dir, "main.js"))) return join(dir, "main.js");
  if (!entry) fail(`${dir} has no src/main.tsx, src/main.ts or src/main.js to build.`);
  const esbuild = await import("esbuild");
  const out = join(dir, "dist", "main.js");
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: "iife",
    platform: "neutral",
    mainFields: ["module", "main"],
    target: "es2022",
    jsx: "transform",
    jsxFactory: "h",
    jsxFragment: "Fragment",
    // Readable, as review reads what's signed, and small enough besides.
    minify: false,
    legalComments: "inline",
    charset: "utf8",
    banner: { js: `// ${manifest.id} ${manifest.version}, built with zuna-plugin.` },
    alias: { "@zuna/plugin": join(SDK, "src", "index.ts") },
    logLevel: "warning",
  });
  return out;
}

/** The files a plugin's folder packs into. @param {string} dir */
function packFiles(dir) {
  const { raw, manifest } = readManifest(dir);
  /** @type {Map<string, Uint8Array>} */
  const files = new Map([["plugin.json", raw]]);
  if (manifest.main) {
    const main = [join(dir, "dist", "main.js"), join(dir, "main.js")].find((file) => existsSync(file));
    if (!main) fail(`${dir}/dist/main.js isn't built.`);
    files.set("main.js", readFileSync(main));
  }
  for (const name of walk(dir, join(dir, "assets"))) files.set(name, readFileSync(join(dir, name)));
  return { files, manifest };
}

/** Says what a package or folder asks for, in the app's words. @param {any} manifest */
function describe(manifest) {
  const lines = [`${manifest.name} ${manifest.version} (${manifest.id}), by ${manifest.author?.name}`];
  const granted = new Set(manifest.permissions ?? []);
  const hosts = manifest.hosts ?? [];
  if ((granted.has("messages.read") || granted.has("files.read")) && granted.has("network")) lines.push(`  ! Can send your messages to ${hosts.join(", ")}`);
  for (const permission of PERMISSIONS) {
    if (!granted.has(permission.id)) continue;
    lines.push(`  - ${permission.id === "network" ? `Contacts ${hosts.join(", ")}` : permission.told}`);
  }
  if (granted.size === 0) lines.push("  Nothing to agree to.");
  return lines.join("\n");
}

const commands = {
  /** @param {string[]} positional @param {Record<string, string>} flags */
  async init(positional, flags) {
    const dir = resolve(positional[0] ?? fail("init needs a folder."));
    if (existsSync(join(dir, "plugin.json"))) fail(`${dir} already has a plugin.json.`);
    const id = flags.id ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const name = flags.name ?? id.replace(/(^|-)([a-z])/g, (_, gap, letter) => (gap ? " " : "") + letter.toUpperCase());
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "assets"), { recursive: true });
    const manifest = {
      manifest: 1,
      id,
      name,
      version: "0.1.0",
      description: "What it does, in a sentence.",
      author: { name: "You" },
      license: "MIT",
      main: "main.js",
      api: 1,
      permissions: [],
      contributes: { commands: [{ id: "hello", title: "Say hello", slash: "hello" }] },
    };
    writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(
      join(dir, "src", "main.tsx"),
      `import { definePlugin, h } from "@zuna/plugin";\n\nexport default definePlugin((zuna) => {\n  zuna.commands.on("hello", ({ composer }) => composer.insert("Hello from ${name}!"));\n\n  zuna.ui.settings(() => (\n    <column gap="m">\n      <text>Nothing to set yet.</text>\n    </column>\n  ));\n});\n`,
    );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true, jsx: "react", jsxFactory: "h", jsxFragmentFactory: "Fragment", noEmit: true, paths: { "@zuna/plugin": [join(relative(dir, SDK), "src", "index.ts").split("\\").join("/")] } }, include: ["src"] }, null, 2) + "\n",
    );
    console.log(`> made ${id} in ${dir}. Build it with zuna-plugin pack ${relative(process.cwd(), dir) || "."}`);
  },

  /** @param {string[]} positional */
  async build(positional) {
    const dir = resolve(positional[0] ?? ".");
    const out = await build(dir);
    console.log(out ? `> built ${out}` : "> a theme has nothing to build");
  },

  /** @param {string[]} positional @param {Record<string, string>} flags */
  async pack(positional, flags) {
    const dir = resolve(positional[0] ?? ".");
    await build(dir);
    const { files, manifest } = packFiles(dir);
    const { problems } = checkFiles(files);
    if (problems.length) fail(`the package wouldn't load:\n  ${problems.join("\n  ")}`);
    const secret = flags.key ? hybrid.readKeyFile(readFileSync(flags.key, "utf8")) : null;
    const zip = makePackage(files, secret);
    const outDir = resolve(flags.out ?? join(dir, "dist"));
    mkdirSync(outDir, { recursive: true });
    const out = join(outDir, `${manifest.id}-${manifest.version}.zunaplugin`);
    writeFileSync(out, zip);
    console.log(`> packed ${out}, ${zip.length} bytes${secret ? ", signed" : ""}\n${describe(manifest)}`);
  },

  /** @param {string[]} positional @param {Record<string, string>} flags */
  async check(positional, flags) {
    const target = resolve(positional[0] ?? ".");
    const keys = flags.public ? flags.public.split(",").map((key) => Buffer.from(key, "base64")) : [];
    let files;
    let signed = false;
    if (statSync(target).isDirectory()) {
      await build(target);
      files = packFiles(target).files;
    } else {
      const opened = openPackage(readFileSync(target), keys);
      files = opened.files;
      signed = opened.signedBy !== null;
      if (files.has("signature") && keys.length && !signed) console.log("! its signature isn't by any key given");
    }
    const { problems, manifest } = checkFiles(files);
    if (manifest) console.log(describe(manifest));
    if (signed) console.log("> signed with a key given");
    if (problems.length) fail(`it wouldn't load:\n  ${problems.join("\n  ")}`);
    console.log("> it would load");
  },

  /** @param {string[]} _positional @param {Record<string, string>} flags */
  async keygen(_positional, flags) {
    const out = flags.out ?? fail("keygen needs --out <file>.");
    if (existsSync(out)) fail(`${out} already exists, and a key is never written over.`);
    const secret = hybrid.generate();
    const pub = hybrid.publicKey(secret).toString("base64");
    writeFileSync(out, `# Zuna's plugin signing key. Whoever has this can sign plugins: keep it offline.\n# Public: ${pub}\n${secret.toString("base64")}\n`, { mode: 0o600 });
    console.log(pub);
  },

  /** @param {string[]} positional */
  async public(positional) {
    const secret = hybrid.readKeyFile(readFileSync(positional[0] ?? fail("public needs a key file."), "utf8"));
    console.log(hybrid.publicKey(secret).toString("base64"));
  },

  /** @param {string[]} positional @param {Record<string, string>} flags */
  async sign(positional, flags) {
    const file = positional[0] ?? fail("sign needs a package.");
    const secret = hybrid.readKeyFile(readFileSync(flags.key ?? fail("sign needs --key <file>."), "utf8"));
    const { files } = openPackage(readFileSync(file));
    const { problems } = checkFiles(files);
    if (problems.length) fail(`the package wouldn't load:\n  ${problems.join("\n  ")}`);
    writeFileSync(file, makePackage(files, secret));
    console.log(`> signed ${file}`);
  },

  /** @param {string[]} _positional @param {Record<string, string>} flags */
  async index(_positional, flags) {
    const secret = hybrid.readKeyFile(readFileSync(flags.key ?? fail("index needs --key <file>."), "utf8"));
    const publicKey = hybrid.publicKey(secret);
    const index = flags.previous && existsSync(flags.previous) ? JSON.parse(readFileSync(flags.previous, "utf8")) : { serial: 0, plugins: [], revoked: [] };
    if (flags.previous && existsSync(flags.previous)) {
      const sig = `${flags.previous}.sig`;
      if (!existsSync(sig) || !indexSigned(readFileSync(flags.previous), readFileSync(sig, "utf8"), [publicKey])) fail("the previous index isn't signed with this key.");
    }
    const packages = flags.packages ? readdirSync(flags.packages).filter((name) => name.endsWith(".zunaplugin")) : [];
    for (const name of packages) {
      const bytes = readFileSync(join(flags.packages, name));
      const { files, signedBy } = openPackage(bytes, [publicKey]);
      if (!signedBy) fail(`${name} isn't signed with this key.`);
      const { problems, manifest } = checkFiles(files);
      if (problems.length) fail(`${name} wouldn't load:\n  ${problems.join("\n  ")}`);
      if (name !== `${manifest.id}-${manifest.version}.zunaplugin`) fail(`${name} should be called ${manifest.id}-${manifest.version}.zunaplugin.`);
      let plugin = index.plugins.find((/** @type {any} */ p) => p.id === manifest.id);
      if (!plugin) index.plugins.push((plugin = { id: manifest.id, versions: [] }));
      const entry = { version: manifest.version, api: manifest.api, minBuild: manifest.minBuild ?? 0, file: name, size: bytes.length, sha256: sha256(bytes), permissions: manifest.permissions, hosts: manifest.hosts ?? [] };
      const published = plugin.versions.find((/** @type {any} */ v) => v.version === manifest.version);
      if (published && published.sha256 !== entry.sha256) fail(`${manifest.id} ${manifest.version} is published already, with other bytes. A new version needs a new number.`);
      if (!published) plugin.versions.push(entry);
      plugin.versions.sort((/** @type {any} */ a, /** @type {any} */ b) => compareVersions(b.version, a.version));
      plugin.versions = plugin.versions.slice(0, Number(flags.keep ?? 5));
      if (plugin.versions[0].version === manifest.version) {
        const icon = manifest.icon ? files.get(manifest.icon) : undefined;
        const mime = manifest.icon?.endsWith(".svg") ? "image/svg+xml" : "image/png";
        Object.assign(plugin, {
          name: manifest.name,
          summary: manifest.description,
          author: manifest.author.name,
          license: manifest.license,
          source: manifest.source ?? "",
          icon: icon && icon.length <= 48 << 10 ? `data:${mime};base64,${Buffer.from(icon).toString("base64")}` : "",
        });
      }
    }
    index.plugins.sort((/** @type {any} */ a, /** @type {any} */ b) => a.id.localeCompare(b.id));
    if (flags.revoked) index.revoked = JSON.parse(readFileSync(flags.revoked, "utf8"));
    index.serial = (index.serial ?? 0) + 1;
    index.made = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    const out = resolve(flags.out ?? ".");
    mkdirSync(out, { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ serial: index.serial, made: index.made, plugins: index.plugins, revoked: index.revoked ?? [] }, null, 2) + "\n");
    writeFileSync(join(out, "index.json"), bytes);
    writeFileSync(join(out, "index.json.sig"), signIndex(bytes, secret));
    console.log(`> index ${index.serial} with ${index.plugins.length} plugins, in ${out}`);
  },
};

/** @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...rest] = process.argv.slice(2);
  const run = /** @type {Record<string, (p: string[], f: Record<string, string>) => Promise<void>>} */ (commands)[command ?? ""];
  if (!run) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 15).map((line) => line.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(command ? 1 : 0);
  }
  const { positional, flags } = parse(rest);
  await run(positional, flags);
}
