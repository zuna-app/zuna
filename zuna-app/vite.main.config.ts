import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["sharp"],
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: "public/zuna.png",
          dest: ".",
        },
      ],
    }),
  ],
});
