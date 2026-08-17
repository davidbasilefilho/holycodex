// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    plugins: ["typescript"],
  },
  pack: {
    entry: ["packages/cli/src/index.ts"],
    outDir: "packages/cli/dist",
    format: ["esm"],
    dts: false,
    clean: true,
    bundle: true,
    platform: "node",
    copy: [{ from: "packages/plugin/assets", to: "packages/cli/dist/assets", flatten: false }],
    noExternal: [/^@holycodex\//u],
    external: [
      "arktype",
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
