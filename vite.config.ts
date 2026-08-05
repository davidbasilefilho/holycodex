import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { defineConfig } from "vite-plus";

const root = import.meta.dirname;

export default defineConfig({
  root,
  test: {
    testTimeout: 20_000,
  },
  plugins: [
    {
      name: "holycodex-runtime-licenses",
      async closeBundle() {
        const runtimeRoot = join(root, "packages", "plugin", "plugin", "runtime");
        await copyFile(
          join(root, "packages", "lsp-daemon", "LICENSE"),
          join(runtimeRoot, "LICENSE-LSP-MIT.txt"),
        );
        await copyFile(
          join(
            root,
            "packages",
            "workflow-runtime",
            "node_modules",
            "quickjs-emscripten",
            "LICENSE",
          ),
          join(runtimeRoot, "LICENSE-QUICKJS-EMSCRIPTEN-MIT.txt"),
        );
      },
    },
  ],
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    ignorePatterns: ["dist/**"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    plugins: ["oxc", "jsdoc", "node", "import", "promise", "unicorn", "typescript"],
  },
  fmt: {
    bracketSameLine: true,
    jsdoc: true,
    sortImports: true,
    sortPackageJson: true,
  },
  build: {
    lib: {
      entry: {
        bootstrap: "packages/cli/src/bootstrap-cli.ts",
        "detect-lsp": "packages/plugin/src/detect-lsp.ts",
        "git-bash": "packages/git-bash/src/cli.ts",
        lsp: "packages/lsp-daemon/src/cli.ts",
        rules: "packages/cli/src/rules-cli.ts",
        workflow: "packages/cli/src/workflow-cli.ts",
        "workflow-evaluator": "packages/workflow-runtime/src/worker-cli.ts",
      },
      formats: ["es"],
    },
    outDir: "packages/plugin/plugin/runtime",
    target: "node26",
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        manualChunks(id) {
          const path = id.replaceAll("\\", "/");
          if (path.endsWith("/packages/cli/src/core-instructions.ts")) return "core-instructions";
          return undefined;
        },
      },
    },
  },
});
