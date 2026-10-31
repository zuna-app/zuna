import { join } from "node:path";
import { defineConfig } from "vitest/config";

const desktopSrc = join(__dirname, "..", "..", "apps", "desktop", "src", "renderer", "src");

export default defineConfig({
  resolve: {
    alias: [
      // Golden files render the desktop's markup with stand-ins for these (golden/stubs.tsx).
      { find: /^@\/components\/(Emote|CodeBlock|Spoiler)$/, replacement: join(__dirname, "golden", "stubs.tsx") },
      { find: /^@\//, replacement: `${desktopSrc}/` },
    ],
  },
  esbuild: { jsx: "automatic" },
  test: {
    globalSetup: ["./src/setup.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Each file starts its own server and hosts; running them one at a time keeps timings honest.
    fileParallelism: false,
  },
});
