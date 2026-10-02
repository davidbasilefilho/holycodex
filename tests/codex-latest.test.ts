// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CODEX_PROTOCOL_VERSION } from "../packages/codex/src/index.ts";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const StableVersionSchema = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
);
const RegistryMetadataSchema = Schema.Struct({ version: StableVersionSchema });
const InstalledPackageSchema = Schema.Struct({ version: StableVersionSchema });
const RootManifestSchema = Schema.Struct({
  devDependencies: Schema.Struct({ "@openai/codex": Schema.Literals(["latest"]) }),
});

describe("latest Codex dependency", () => {
  test("keeps the installed package, lockfile, and generated protocol on npm's current latest", async () => {
    const rootManifestText = await readFile(resolve(workspaceRoot, "package.json"), "utf8");
    const rootManifest = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.fromJsonString(RootManifestSchema))(rootManifestText),
    );
    expect(rootManifest.devDependencies["@openai/codex"]).toBe("latest");

    const installedManifestPath = require.resolve("@openai/codex/package.json");
    const installedManifestText = await readFile(installedManifestPath, "utf8");
    const installedManifest = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledPackageSchema))(
        installedManifestText,
      ),
    );

    const lockfile = await readFile(resolve(workspaceRoot, "bun.lock"), "utf8");
    const lockedVersionText = /"@openai\/codex": \["@openai\/codex@([^"-]+)"/u.exec(lockfile)?.[1];
    const lockedVersion = await Effect.runPromise(
      Schema.decodeUnknownEffect(StableVersionSchema)(lockedVersionText),
    );

    const latestMetadata = await Effect.runPromise(
      Effect.tryPromise({
        try: async () => {
          const response = await fetch("https://registry.npmjs.org/@openai%2Fcodex/latest");
          if (!response.ok) {
            throw new Error(`npm registry returned HTTP ${response.status}`);
          }
          const body: unknown = await response.json();
          return body;
        },
        catch: (error) =>
          new Error(
            `Could not read the current @openai/codex latest dist-tag from npm: ${String(error)}`,
          ),
      }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RegistryMetadataSchema))),
    );

    const protocolVersion = await Effect.runPromise(
      Schema.decodeUnknownEffect(
        Schema.String.check(
          Schema.isPattern(/^codex-cli-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u),
        ),
      )(CODEX_PROTOCOL_VERSION),
    );
    const protocolVersionNumber = protocolVersion.slice("codex-cli-".length);

    expect(installedManifest.version, "installed @openai/codex is behind npm latest").toBe(
      latestMetadata.version,
    );
    expect(lockedVersion, "bun.lock resolves @openai/codex behind npm latest").toBe(
      latestMetadata.version,
    );
    expect(protocolVersionNumber, "generated Codex protocol bindings are behind npm latest").toBe(
      latestMetadata.version,
    );
  }, 30_000);
});
