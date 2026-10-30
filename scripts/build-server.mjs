// Cross-compiles the server for every supported platform into dist/server.
// The server is pure Go, so this needs nothing besides the Go toolchain.
import { join } from "node:path";
import { env, root, run } from "./lib.mjs";

const targets = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["windows", "amd64"],
];

const version = process.env.ZUNA_VERSION ?? "dev";

for (const [goos, goarch] of targets) {
  const name = `zuna-server-${goos}-${goarch}${goos === "windows" ? ".exe" : ""}`;
  run(
    "go",
    [
      "build",
      "-trimpath",
      "-ldflags",
      `-s -w -X main.version=${version}`,
      "-o",
      join(root, "dist", "server", name),
      "./cmd/zuna-server",
    ],
    {
      cwd: join(root, "server"),
      env: { ...env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
    },
  );
}
