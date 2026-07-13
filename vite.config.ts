import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: { entry: "src/cli.ts", formats: ["es"], fileName: "cli" },
    target: "node20",
    minify: false,
    rollupOptions: { external: [/^node:/] },
  },
});
