// Runs the Rust tests as WebAssembly under Node, the same target the app ships.
import { join } from "node:path";
import { root, run } from "./lib.mjs";

run("cargo", ["test", "--target", "wasm32-unknown-unknown", "--lib"], {
  cwd: join(root, "crypto"),
});
