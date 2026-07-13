import { defineConfig } from "vite";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  build: {
    lib: {
      entry: {
        bootstrap: "src/bootstrap-cli.ts",
        cli: "src/cli.ts",
        "git-bash": "packages/git-bash-mcp/src/cli.ts",
        lsp: "packages/lsp-daemon/src/cli.ts",
        rules: "src/rules-cli.ts",
      },
      formats: ["es"],
    },
    outDir: "plugin/runtime",
    target: "node20",
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (path.endsWith("/src/core-instructions.ts")) return "core-instructions";
          if (path.includes("/packages/mcp-stdio-core/src/")) return "mcp-stdio-core";
          return undefined;
        },
      },
    },
  },
});
