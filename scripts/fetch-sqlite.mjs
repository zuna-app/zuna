// Downloads the SQLite amalgamation the iOS app compiles in. Every client runs the same
// SQLite, including FTS5 with contentless_delete, so move these together: VERSION here,
// `@sqlite.org/sqlite-wasm` in packages/ui/package.json, which the web app ships, and
// `rusqlite` in apps/desktop/Cargo.toml, whose bundled libsqlite3-sys the native app links.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { root, run } from "./lib.mjs";

const VERSION = "3.54.1";
const URL = "https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip";
const SHA3_256 = "92281c86e2957f9b9305890f9ac04204caa7b677cc868dc326d942689df28e30";

const target = join(root, "apps", "ios", "ZunaKit", "Sources", "CSQLite");
const stamp = join(target, ".version");

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === VERSION) process.exit(0);

console.log(`> downloading SQLite ${VERSION}`);
const response = await fetch(URL);
if (!response.ok) throw new Error(`SQLite download failed with status ${response.status}`);
const zip = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha3-256").update(zip).digest("hex");
if (digest !== SHA3_256) throw new Error(`SQLite download has the wrong checksum: ${digest}`);

const work = mkdtempSync(join(tmpdir(), "zuna-sqlite-"));
writeFileSync(join(work, "sqlite.zip"), zip);
run("unzip", ["-q", "-o", join(work, "sqlite.zip"), "-d", work]);
const extracted = join(work, "sqlite-amalgamation-3540100");

mkdirSync(join(target, "include"), { recursive: true });
renameSync(join(extracted, "sqlite3.c"), join(target, "sqlite3.c"));
renameSync(join(extracted, "sqlite3.h"), join(target, "include", "sqlite3.h"));
writeFileSync(stamp, `${VERSION}\n`);
rmSync(work, { recursive: true, force: true });
