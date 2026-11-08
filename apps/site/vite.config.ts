import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  // build.mjs fills this in from the latest GitHub release. Without one, downloads lead to the releases page.
  define: { __RELEASE__: "null" },
  build: {
    target: ["es2022", "chrome120", "edge120", "firefox128", "safari17"],
    // Everything stays a separate file, as the content security policy expects.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    outDir: "dist",
    emptyOutDir: true,
  },
  server: { port: 5175, strictPort: true },
  preview: { port: 5175, strictPort: true },
});
