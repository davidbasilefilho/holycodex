import { defineConfig } from "vite";

export default defineConfig({
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
      output: { entryFileNames: "[name].js" },
    },
  },
});
