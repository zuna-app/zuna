import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const sharedSrcPath = path.resolve(__dirname, "../zuna-shared/src");

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": sharedSrcPath,
      "@zuna/shared": path.resolve(sharedSrcPath, "index.ts"),
    },
  },
  optimizeDeps: {
    force: true,
    exclude: ["@zuna/shared"],
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "motion/react",
      "jotai",
      "@tanstack/react-query",
      "react-use-websocket",
      "lucide-react",
      "clsx",
      "tailwind-merge",
      "class-variance-authority",
      "react-virtualized",
      "radix-ui",
      "next-themes",
      "sonner",
      "react-spinners",
      "react-dropzone",
      "react-icons",
      "input-otp",
      "emoji-js",
      "highlight.js",
    ],
  },
  server: {
    warmup: {
      clientFiles: ["./src/renderer.tsx"],
    },
  },
});
