// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["packages/codex/generated/**"],
  },
  lint: {
    ignorePatterns: ["packages/codex/generated/**"],
    plugins: ["typescript"],
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
    dts: false,
    clean: true,
    bundle: true,
    platform: "node",
    noExternal: [/^@holycodex\//u],
  },
});
