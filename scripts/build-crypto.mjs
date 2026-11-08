// Compiles the Rust encryption core to WebAssembly for @zuna/crypto.
import { join } from "node:path";
import { root, run } from "./lib.mjs";

const crate = join(root, "crypto");

// The crate is a Rust library to the desktop app, so the WebAssembly module is asked for here.
run("cargo", ["rustc", "--release", "--lib", "--target", "wasm32-unknown-unknown", "--crate-type", "cdylib"], { cwd: crate });
run("wasm-bindgen", [
  "--target",
  "web",
  "--out-dir",
  join(root, "packages", "crypto", "pkg"),
  join(crate, "target", "wasm32-unknown-unknown", "release", "zuna_crypto.wasm"),
]);
