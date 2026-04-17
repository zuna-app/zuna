import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const STORAGE_PATH = join(homedir(), ".zuna-cli.json");

const DEFAULT = {
  sigPublicKey: null,
  sigPrivateKey: null,
  encPublicKey: null,
  encPrivateKey: null,
  servers: [], // [{ id, address, name, username }]
};

export function load() {
  if (!existsSync(STORAGE_PATH)) return { ...DEFAULT };
  try {
    const raw = readFileSync(STORAGE_PATH, "utf8");
    return { ...DEFAULT, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT };
  }
}

export function save(data) {
  writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function storagePath() {
  return STORAGE_PATH;
}
