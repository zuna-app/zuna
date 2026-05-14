import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import tsconfigPaths from "vite-tsconfig-paths";

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: ["sharp"],
    },
  },
  plugins: [
    tsconfigPaths(),
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
