import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  build: {
    lib: {
      entry: { cli: "src/cli.ts" },
      formats: ["es"],
    },
    outDir: "dist",
    target: "node20",
    minify: false,
    rollupOptions: {
      external: [/^node:/, "@holycodex/plugin"],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
      },
    },
  },
});
