// SPDX-License-Identifier: Apache-2.0

import { runSafeFilesystemNativeTest } from "./safe-filesystem-native-test.ts";

if (import.meta.main) {
  const helperPath = process.argv[2];
  if (helperPath === undefined) {
    console.error(
      JSON.stringify({ status: "failed", message: "safe filesystem smoke requires a helper path" }),
    );
    process.exitCode = 1;
  } else {
    try {
      await runSafeFilesystemNativeTest(helperPath);
      console.log(JSON.stringify({ status: "verified", helperPath }));
    } catch (error: unknown) {
      console.error(
        JSON.stringify({
          status: "failed",
          message: error instanceof Error ? error.message : "safe filesystem smoke failed",
        }),
      );
      process.exitCode = 1;
    }
  }
}
