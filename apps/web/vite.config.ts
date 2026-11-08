import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants } from "node:zlib";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** The version every app is released with, the root package.json's, which About shows. */
const version: string = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")).version;

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

/**
 * Writes name.br beside each file brotli makes much smaller, which zuna-web serves to
 * browsers that take it (webhost.go): a fifth less than gzip for the script, and a
 * third for the crypto core's WebAssembly, on everyone's first visit.
 */
function brotliFiles(): Plugin {
  const squeeze = promisify(brotliCompress);
  let outDir = "";
  return {
    name: "zuna-brotli",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const file = join(dir, name);
          if (statSync(file).isDirectory()) walk(file);
          else if (/\.(js|mjs|css|html|wasm|json|svg|txt)$/.test(name) && statSync(file).size > 1024) files.push(file);
        }
      };
      walk(outDir);
      await Promise.all(
        files.map(async (file) => {
          const body = readFileSync(file);
          const squeezed = await squeeze(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } });
          if (squeezed.length < body.length * 0.9) writeFileSync(`${file}.br`, squeezed);
        }),
      );
    },
  };
}

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), buildVersion(), brotliFiles()],
  // What npm run dev:web gives the sign-in form to start with, which only development reads.
  envPrefix: "ZUNA_DEV_",
  define: { "import.meta.env.ZUNA_VERSION": JSON.stringify(version) },
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
