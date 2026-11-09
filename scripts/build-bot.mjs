// Builds zuna-bot into dist/bot: one file that Node 22.22 or later runs, and the
// cryptography beside it. apps/bot/Dockerfile makes an image of the two.
import { join } from "node:path";
import { ensureBuilt, root, run } from "./lib.mjs";

ensureBuilt();
run(process.execPath, [join(root, "apps", "bot", "build.mjs")]);
