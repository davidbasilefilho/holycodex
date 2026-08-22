// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { packPublicPackage } from "./package-smoke.ts";
import { withTemporaryDirectory } from "./process.ts";

const ArgumentsSchema = Schema.Tuple(
  Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
);

async function packageRelease(args: readonly string[]): Promise<string> {
  const parsed = Schema.decodeUnknownEither(ArgumentsSchema)(args);
  if (Either.isLeft(parsed)) {
    throw new Error("Usage: bun scripts/package-release.ts <output-directory>");
  }
  const outputDirectory = resolve(parsed.right[0]);
  await mkdir(outputDirectory, { recursive: true });
  return await withTemporaryDirectory("holycodex-package-release", async (temporaryRoot) => {
    const packed = await packPublicPackage(temporaryRoot);
    const output = join(outputDirectory, packed.tarball);
    await cp(packed.tarballPath, output);
    return output;
  });
}

if (import.meta.main) {
  try {
    console.log(
      JSON.stringify({ status: "packed", output: await packageRelease(Bun.argv.slice(2)) }),
    );
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        status: "failed",
        message: error instanceof Error ? error.message : "release packaging failed",
      }),
    );
    process.exitCode = 1;
  }
}
