import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __ZUNA_SIGNED_BUILD__: JSON.stringify(process.env.ZUNA_SIGNED_BUILD === "1"),
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react() as never],
    resolve: {
      alias: { "@": resolve(__dirname, "../../packages/ui/src") },
    },
    optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
    worker: { format: "es" },
    build: {
      target: "esnext",
      // Everything stays a separate file, as the content security policy expects.
      assetsInlineLimit: 0,
      rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } },
    },
  },
});
