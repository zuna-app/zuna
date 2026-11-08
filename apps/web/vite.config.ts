import { createHash } from "node:crypto";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** version.json names this build, so a tab left open can tell when its host has a newer one. */
function buildVersion(): Plugin {
  return {
    name: "zuna-build-version",
    apply: "build",
    generateBundle(_options, bundle) {
      const hash = createHash("sha256");
      for (const name of Object.keys(bundle).sort()) {
        const item = bundle[name]!;
        hash.update(name);
        hash.update(item.type === "chunk" ? item.code : item.source);
      }
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ build: hash.digest("hex").slice(0, 16) })}\n` });
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), buildVersion()],
  // What npm run dev:web gives the sign-in form to start with, which only development reads.
  envPrefix: "ZUNA_DEV_",
  resolve: { alias: { "@": resolve(import.meta.dirname, "../../packages/ui/src") } },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: {
    target: ["es2022", "chrome120", "edge120", "firefox128", "safari17"],
    // Everything stays a separate file, as the content security policy expects.
    assetsInlineLimit: 0,
    outDir: "dist",
    emptyOutDir: true,
    // The app and the C++ grammar for code blocks are big, and only load once.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    port: 5174,
    strictPort: true,
    // Link previews and the host's settings come from zuna-web (scripts/dev-web.mjs starts one).
    proxy: { "/_zuna": "http://127.0.0.1:8790" },
  },
});
