// Serves the renderer in a plain browser, which speeds up UI work. Zuna doesn't
// ship a web client: see SECURITY.md for why installed apps are the safe option.
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src/renderer/src") } },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  server: { port: 5173, strictPort: true },
});
