// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: ["packages/codex/generated/**"],
  },
  lint: {
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
    outExtensions: () => ({ js: ".js" }),
    dts: false,
    clean: true,
    bundle: true,
    platform: "node",
    noExternal: [/^@holycodex\//u],
    external: [
      "quickjs-emscripten",
      "quickjs-emscripten-core",
      "@jitl/quickjs-ffi-types",
      "@jitl/quickjs-wasmfile-debug-asyncify",
      "@jitl/quickjs-wasmfile-debug-sync",
      "@jitl/quickjs-wasmfile-release-asyncify",
      "@jitl/quickjs-wasmfile-release-sync",
      "typescript",
    ],
  },
});
