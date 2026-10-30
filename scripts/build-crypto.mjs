// Compiles the Rust encryption core to WebAssembly for @zuna/crypto.
import { join } from "node:path";
import { root, run } from "./lib.mjs";

const crate = join(root, "crypto");

run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: crate });
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  join(root, "packages", "crypto", "pkg"),
  join(crate, "target", "wasm32-unknown-unknown", "release", "zuna_crypto.wasm"),
]);
