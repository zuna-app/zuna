// Compiles the Rust encryption core for the iOS app: static libraries for iOS
// devices, the iOS simulator and macOS (where tests run the same code without
// a simulator), packaged as an XCFramework, plus the Swift bindings UniFFI
// generates from the compiled library.

import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env, root, run } from "./lib.mjs";

const crate = join(root, "crypto");
const kit = join(root, "apps", "ios", "ZunaKit");
const work = join(crate, "target", "apple");

const targets = [
  { triple: "aarch64-apple-ios", env: { IPHONEOS_DEPLOYMENT_TARGET: "18.0" } },
  { triple: "aarch64-apple-ios-sim", env: { IPHONEOS_DEPLOYMENT_TARGET: "18.0" } },
  { triple: "aarch64-apple-darwin", env: { MACOSX_DEPLOYMENT_TARGET: "15.0" } },
];
const library = (triple) => join(crate, "target", triple, "release", "libzuna_crypto.a");

for (const target of targets) {
  run("cargo", ["rustc", "--release", "--lib", "--target", target.triple, "--crate-type", "staticlib", "--features", "uniffi"], {
    cwd: crate,
    env: { ...env, ...target.env },
  });
}

rmSync(work, { recursive: true, force: true });
const generated = join(work, "generated");
run(
  "cargo",
  [
    "run",
    "--release",
    "--quiet",
    "--manifest-path",
    join(crate, "bindgen", "Cargo.toml"),
    "--target-dir",
    join(crate, "target"),
    "--",
    "generate",
    "--library",
    library("aarch64-apple-darwin"),
    "--language",
    "swift",
    "--out-dir",
    generated,
  ],
  { cwd: crate },
);

// An XCFramework's headers need a module map named module.modulemap.
const headers = join(work, "headers");
mkdirSync(headers, { recursive: true });
cpSync(join(generated, "zuna_cryptoFFI.h"), join(headers, "zuna_cryptoFFI.h"));
cpSync(join(generated, "zuna_cryptoFFI.modulemap"), join(headers, "module.modulemap"));

const xcframework = join(kit, "Frameworks", "ZunaCryptoFFI.xcframework");
rmSync(xcframework, { recursive: true, force: true });
run("xcodebuild", [
  "-create-xcframework",
  ...targets.flatMap((target) => ["-library", library(target.triple), "-headers", headers]),
  "-output",
  xcframework,
]);

const bindings = join(kit, "Sources", "ZunaCrypto", "Generated");
mkdirSync(bindings, { recursive: true });
cpSync(join(generated, "zuna_crypto.swift"), join(bindings, "zuna_crypto.swift"));
