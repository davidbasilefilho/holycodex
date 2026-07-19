import { resolve } from "node:path";

import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      "@holycodex/mcp-stdio-core": resolve(import.meta.dirname, "../mcp-stdio-core/src/index.ts"),
    },
  },
  build: {
    lib: {
      entry: { index: "src/index.ts", cli: "src/cli.ts" },
      formats: ["es"],
    },
    outDir: "dist",
    target: "node20",
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
      },
    },
  },
});
