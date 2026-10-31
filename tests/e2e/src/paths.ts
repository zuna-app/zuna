import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const hostBinary = join(root, "apps", "ios", "ZunaKit", ".build", "debug", "zuna-host");
