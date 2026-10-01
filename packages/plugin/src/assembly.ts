// SPDX-License-Identifier: Apache-2.0

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import * as Effect from "effect/Effect";

import {
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  PAYLOAD_MANIFEST_PATH,
  SOURCE_MANIFEST_PATH,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import type { PluginError } from "./errors.ts";
import { planAssemblyEffect } from "./planning.ts";
import { decodeSchema, PayloadManifestSchema, parseAssemblyRequest } from "./schemas.ts";
import { comparePathText, readSourceFileEffect, resolveStagingRootEffect } from "./source.ts";
import type { AssembledPayload, AssemblyPlan, PayloadManifest } from "./types.ts";
import { canonicalJsonBytes, sha256Effect, verifyPayloadEffect } from "./verification.ts";

/** Assemble, stage, and verify a deterministic plugin payload from an assembly request. */
export function assemblePayload(input: unknown): Promise<AssembledPayload> {
  return Effect.runPromise(assemblePayloadEffect(input));
}

/** Assemble, stage, and verify a deterministic payload in the plugin effect domain. */
export function assemblePayloadEffect(
  input: unknown,
): Effect.Effect<AssembledPayload, PluginError> {
  return Effect.gen(function* () {
    const request = yield* Effect.try({
      try: () => parseAssemblyRequest(input),
      catch: (error) => error as PluginError,
    });
    const plan = yield* planAssemblyEffect(request);
    yield* assertSafeStagingEffect(plan.sourceRoot, plan.stagingDirectory);
    yield* ensureEmptyStagingDirectoryEffect(plan.stagingDirectory);
    const stagedBytes = new Map<string, Uint8Array>();
    stagedBytes.set(SOURCE_MANIFEST_PATH, canonicalJsonBytes(plan.manifest));
    for (const file of plan.files) {
      if (file.path !== SOURCE_MANIFEST_PATH) {
        stagedBytes.set(file.path, yield* readSourceFileEffect(plan.sourceRoot, file.path));
      }
    }
    const payloadManifest = yield* createPayloadManifestEffect(plan, stagedBytes);
    const payloadManifestBytes = canonicalJsonBytes(payloadManifest);
    if (payloadManifestBytes.byteLength > MAX_FILE_SIZE) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The generated payload metadata exceeds the size limit."),
      );
    }
    if (
      plan.files.reduce((total, file) => total + file.size, payloadManifestBytes.byteLength) >
      MAX_TOTAL_SIZE
    ) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The generated payload exceeds the total size limit."),
      );
    }
    stagedBytes.set(PAYLOAD_MANIFEST_PATH, payloadManifestBytes);
    for (const [path, bytes] of [...stagedBytes.entries()].sort(([left], [right]) =>
      comparePathText(left, right),
    )) {
      yield* writeStagedFileEffect(plan.stagingDirectory, path, bytes);
    }
    const verified = yield* verifyPayloadEffect(plan.stagingDirectory);
    return { ...verified, plan };
  });
}

function createPayloadManifestEffect(
  plan: AssemblyPlan,
  stagedBytes: ReadonlyMap<string, Uint8Array>,
): Effect.Effect<PayloadManifest, PluginError> {
  return Effect.gen(function* () {
    for (const file of plan.files) {
      const bytes = stagedBytes.get(file.path);
      if (
        !bytes ||
        bytes.byteLength !== file.size ||
        (yield* sha256Effect(bytes)) !== file.sha256
      ) {
        return yield* Effect.fail(
          pluginError("payload_invalid", "A staged file does not match the assembly plan.", {
            path: file.path,
          }),
        );
      }
    }
    const files = plan.files.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
    }));
    const parsed = decodeSchema(PayloadManifestSchema, {
      schema_epoch: plan.schemaEpoch,
      version: plan.version,
      files,
      payload_digest: plan.payloadDigest,
      identity: plan.identity,
    });
    if (parsed === undefined) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The generated payload manifest is invalid.", {
          summary: "Effect Schema rejected the generated payload manifest.",
          staged_files: stagedBytes.size,
        }),
      );
    }
    return parsed;
  });
}

function assertSafeStagingEffect(
  sourceRoot: string,
  stagingDirectory: string,
): Effect.Effect<void, PluginError> {
  const sourceRelative = relative(sourceRoot, stagingDirectory);
  if (sourceRelative === "" || (!sourceRelative.startsWith("..") && !isAbsolute(sourceRelative))) {
    return Effect.fail(
      pluginError(
        "staging_invalid",
        "The staging directory must be outside the plugin source root.",
      ),
    );
  }
  return Effect.void;
}

function ensureEmptyStagingDirectoryEffect(
  stagingDirectory: string,
): Effect.Effect<void, PluginError> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(stagingDirectory, { recursive: true }),
      catch: (error) =>
        pluginError(
          "staging_invalid",
          "The payload staging directory cannot be created.",
          {},
          error,
        ),
    });
    const root = yield* resolveStagingRootEffect(stagingDirectory);
    const entries = yield* Effect.tryPromise({
      try: () => readdir(root),
      catch: (error) =>
        pluginError("staging_invalid", "The payload staging directory cannot be read.", {}, error),
    });
    if (entries.length !== 0)
      return yield* Effect.fail(
        pluginError("staging_invalid", "The staging directory must be empty."),
      );
  });
}

function writeStagedFileEffect(
  root: string,
  path: string,
  bytes: Uint8Array,
): Effect.Effect<void, PluginError> {
  const destination = join(root, path);
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => mkdir(dirname(destination), { recursive: true }),
      catch: (error) =>
        pluginError(
          "staging_invalid",
          "A payload subdirectory cannot be created.",
          { path },
          error,
        ),
    });
    yield* Effect.tryPromise({
      try: () => writeFile(destination, bytes),
      catch: (error) =>
        pluginError("staging_invalid", "A payload file cannot be written.", { path }, error),
    });
  });
}
