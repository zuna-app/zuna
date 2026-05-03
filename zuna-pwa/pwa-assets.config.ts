import { defineConfig, minimalPreset } from "@vite-pwa/assets-generator/config";

export default defineConfig({
  preset: {
    ...minimalPreset,
    apple: {
      sizes: [180],
    },
  },
  images: ["public/zuna-logo.png"],
});
