// Bundles the client core, with its polyfills and native shims, into the scripts the iOS host
// loads into JavaScriptCore: the core, code highlighting, loaded when the first code block
// shows, and the password meter's word lists, apart too as the core also runs in the
// notification extension, which has little memory.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleCore } from "./bundle.mjs";
import { buildWatchPage } from "../../../packages/watch/build.mjs";

const resources = join(dirname(fileURLToPath(import.meta.url)), "..", "ZunaKit", "Sources", "ZunaHost", "Resources");
// The JavaScriptCore in iOS 18 matches Safari 18.
const written = await bundleCore({ target: "safari18", outDir: resources });
// The page a video watched together plays in, in a WKWebView of the app's.
written.push(await buildWatchPage(resources, "safari18"));
console.log(`> wrote ${written.join(", ")}`);
