// Bundles the client core for the native desktop app, which runs it in QuickJS. The core
// is the same one the iOS app loads into JavaScriptCore, built the same way, with the same
// polyfills and native shims (apps/ios/core-bundle): the Rust host installs the same
// __zunaHost, __zunaCrypto and __zunaDb that the Swift host does. Code highlighting is
// bundled too, though nothing in the app loads it yet: it draws code blocks in one color.
//
//   node apps/desktop/core-bundle/build.mjs

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCore } from "../../ios/core-bundle/bundle.mjs";
import { buildWatchPage } from "../../../packages/watch/build.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "core");
// QuickJS-ng has ES2023, but lowering a little further costs nothing and keeps clear of its gaps.
await bundleCore({ target: "es2022", outDir: out });
// The page a video watched together plays in, in the system's web view: WebKit on macOS, WebView2 on Windows.
await buildWatchPage(out, "es2022");
console.log(`> wrote the core bundles to ${out}`);
