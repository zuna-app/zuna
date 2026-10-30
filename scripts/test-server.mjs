import { join } from "node:path";
import { root, run } from "./lib.mjs";

run("go", ["test", "./..."], { cwd: join(root, "server") });
