// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "bun run --sequential check:fix test",
  },
  fmt: {
    ignorePatterns: ["packages/codex/generated/**"],
    bracketSameLine: true,
    jsdoc: true,
    sortImports: true,
    sortPackageJson: true,
  },
  lint: {
    ignorePatterns: ["packages/codex/generated/**"],
    plugins: ["typescript", "eslint", "import", "jsdoc", "oxc", "unicorn"],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    entry: ["packages/cli/src/index.ts"],
    outDir: "packages/cli/dist",
    format: ["esm"],
    banner: "#!/usr/bin/env bun",
    outExtensions: () => ({ js: ".js" }),
    minify: true,
    dts: false,
    clean: true,
    bundle: true,
    platform: "node",
    noExternal: [/^@holycodex\//u],
  },
});
