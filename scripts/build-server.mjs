// Cross-compiles the server for every supported platform into dist/server.
// The server is pure Go, so this needs nothing besides the Go toolchain.
import { join } from "node:path";
import { goBuildAll, root } from "./lib.mjs";

goBuildAll("./cmd/zuna-server", join(root, "dist", "server"), "zuna-server");
