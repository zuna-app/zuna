import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    force: true,
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
      "tweetnacl",
      "react-virtualized",
      "radix-ui",
      "next-themes",
      "sonner",
      "react-hot-toast",
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
