import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["zuna.png", "zuna-192.png", "zuna-512.png"],
      manifest: {
        name: "Zuna",
        short_name: "Zuna",
        description: "Fully self-hosted, end-to-end encrypted chat",
        theme_color: "#0a0a0a",
        background_color: "#0a0a0a",
        display: "standalone",
        icons: [
          { src: "zuna-192.png", sizes: "192x192", type: "image/png" },
          { src: "zuna-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../zuna-shared/src"),
    },
  },
});
