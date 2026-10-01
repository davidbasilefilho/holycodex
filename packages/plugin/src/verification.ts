// SPDX-License-Identifier: Apache-2.0

import {
  createSha256Digest,
  type Sha256Digest,
  canonicalJson,
  sha256DomainDigest,
} from "@holycodex/core";
import * as Effect from "effect/Effect";

import {
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  PAYLOAD_MANIFEST_PATH,
  SOURCE_MANIFEST_PATH,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import type { PluginError } from "./errors.ts";
import {
  PayloadIdentitySchema,
  decodeSchema,
  parsePayloadLocation,
  readGeneratedManifestEffect,
  readPayloadManifestEffect,
  declaredSourcePaths,
} from "./schemas.ts";
import {
  compareFiles,
  comparePathText,
  readPayloadFileEffect,
  resolveStagingRootEffect,
  walkPayloadEffect,
} from "./source.ts";
import type { PayloadIdentity, VerifiedPayload } from "./types.ts";

/** Verify staged plugin metadata, files, canonical bytes, and aggregate identity. */
export function verifyPayload(input: unknown): Promise<VerifiedPayload> {
  return Effect.runPromise(verifyPayloadEffect(input));
}

/** Verify a staged payload in the plugin effect domain. */
export function verifyPayloadEffect(input: unknown): Effect.Effect<VerifiedPayload, PluginError> {
  return Effect.gen(function* () {
    const stagingDirectory = yield* Effect.try({
      try: () => parsePayloadLocation(input),
      catch: (error) => error as PluginError,
    });
    const root = yield* resolveStagingRootEffect(stagingDirectory);
    const payloadManifest = yield* readPayloadManifestEffect(root);
    const generatedManifest = yield* readGeneratedManifestEffect(root);
    if (generatedManifest.version !== payloadManifest.version) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "Generated metadata versions do not match."),
      );
    }
    if (payloadManifest.identity.epoch !== payloadManifest.schema_epoch) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "Payload identity epoch does not match metadata."),
      );
    }
    const declaredPaths = [
      ...declaredSourcePaths(
        generatedManifest,
        payloadManifest.files.map((file) => file.path),
      ),
    ].sort(comparePathText);
    const manifestPaths = payloadManifest.files.map((file) => file.path);
    if (
      declaredPaths.length !== manifestPaths.length ||
      declaredPaths.some((path, index) => path !== manifestPaths[index])
    ) {
      return yield* Effect.fail(
        pluginError(
          "payload_invalid",
          "Generated metadata and the payload file manifest disagree.",
        ),
      );
    }
    const expectedPaths = new Set([...manifestPaths, PAYLOAD_MANIFEST_PATH]);
    const actualPaths: string[] = [];
    yield* walkPayloadEffect(root, "", actualPaths);
    for (const expectedPath of expectedPaths) {
      if (!actualPaths.includes(expectedPath)) {
        return yield* Effect.fail(
          pluginError("payload_invalid", "A payload file is missing.", { path: expectedPath }),
        );
      }
    }
    for (const actualPath of actualPaths) {
      if (!expectedPaths.has(actualPath)) {
        return yield* Effect.fail(
          pluginError("payload_invalid", "The payload contains an unexpected file.", {
            path: actualPath,
          }),
        );
      }
    }
    const fileBytes = new Map<string, Uint8Array>();
    const payloadMetadataBytes = yield* readPayloadFileEffect(root, PAYLOAD_MANIFEST_PATH);
    if (payloadMetadataBytes.byteLength > MAX_FILE_SIZE) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "The payload metadata exceeds the size limit."),
      );
    }
    let totalSize = payloadMetadataBytes.byteLength;
    for (const file of payloadManifest.files) {
      const bytes = yield* readPayloadFileEffect(root, file.path);
      if (bytes.byteLength !== file.size) {
        return yield* Effect.fail(
          pluginError("digest_invalid", "A payload file size does not match its manifest.", {
            path: file.path,
          }),
        );
      }
      const digest = yield* sha256Effect(bytes);
      if (digest !== file.sha256) {
        return yield* Effect.fail(
          pluginError("digest_invalid", "A payload file digest does not match its manifest.", {
            path: file.path,
          }),
        );
      }
      totalSize += bytes.byteLength;
      if (bytes.byteLength > MAX_FILE_SIZE || totalSize > MAX_TOTAL_SIZE) {
        return yield* Effect.fail(
          pluginError("payload_invalid", "The payload exceeds the size limit."),
        );
      }
      fileBytes.set(file.path, bytes);
    }
    const digest = yield* digestPayloadEffect(
      payloadManifest.version,
      payloadManifest.schema_epoch,
      payloadManifest.files,
      (path) => {
        const bytes = fileBytes.get(path);
        return bytes === undefined
          ? Effect.fail(
              pluginError("payload_invalid", "A payload digest input is missing.", { path }),
            )
          : Effect.succeed(bytes);
      },
    );
    if (digest !== payloadManifest.payload_digest || digest !== payloadManifest.identity.digest) {
      return yield* Effect.fail(
        pluginError("digest_invalid", "The payload digest does not match its contents."),
      );
    }
    const canonicalMetadata = canonicalJsonBytes(payloadManifest);
    const onDiskMetadata = yield* readPayloadFileEffect(root, PAYLOAD_MANIFEST_PATH);
    if (!bytesEqual(canonicalMetadata, onDiskMetadata)) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "Payload metadata is not canonical."),
      );
    }
    const canonicalGenerated = canonicalJsonBytes(generatedManifest);
    const onDiskGenerated = yield* readPayloadFileEffect(root, SOURCE_MANIFEST_PATH);
    if (!bytesEqual(canonicalGenerated, onDiskGenerated)) {
      return yield* Effect.fail(
        pluginError("payload_invalid", "Generated plugin metadata is not canonical."),
      );
    }
    return {
      stagingDirectory: root,
      manifest: payloadManifest,
      identity: payloadManifest.identity,
    };
  });
}

/** Validate and construct the immutable payload identity record. */
export function createIdentity(
  version: string,
  digest: Sha256Digest,
  epoch: string,
): PayloadIdentity {
  const parsed = decodeSchema(PayloadIdentitySchema, { version, digest, epoch });
  if (parsed === undefined) {
    throw pluginError("payload_invalid", "The payload identity is invalid.", {
      summary: "Effect Schema rejected the payload identity.",
    });
  }
  return parsed;
}

/** Hash ordered payload metadata and bytes while detecting source changes. */
export function digestPayload(
  version: string,
  epoch: string,
  files: readonly DigestFile[],
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<Sha256Digest> {
  return Effect.runPromise(
    digestPayloadEffect(version, epoch, files, (path) =>
      Effect.tryPromise({
        try: () => readBytes(path),
        catch: (error) =>
          pluginError(
            "source_invalid",
            "A source file could not be read during assembly.",
            { path },
            error,
          ),
      }),
    ),
  );
}

/** Hash ordered payload metadata in the plugin effect domain. */
export function digestPayloadEffect(
  version: string,
  epoch: string,
  files: readonly DigestFile[],
  readBytes: (path: string) => Effect.Effect<Uint8Array, PluginError>,
): Effect.Effect<Sha256Digest, PluginError> {
  return Effect.gen(function* () {
    const parts: Uint8Array[] = [
      new TextEncoder().encode(version),
      new TextEncoder().encode(epoch),
    ];
    for (const file of [...files].sort(compareFiles)) {
      const bytes = yield* readBytes(file.path);
      const digest = yield* sha256Effect(bytes);
      if (bytes.byteLength !== file.size || digest !== file.sha256) {
        return yield* Effect.fail(
          pluginError("source_invalid", "A source file changed during assembly.", {
            path: file.path,
          }),
        );
      }
      parts.push(new TextEncoder().encode(file.path), bytes);
    }
    return yield* Effect.tryPromise({
      try: () => sha256DomainDigest("plugin-payload", parts),
      catch: (error) =>
        pluginError("digest_invalid", "Unable to compute payload identity.", {}, error),
    });
  });
}

/** Encode a value as canonical JSON bytes with a terminal newline. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

/** Compute a standards-based SHA-256 digest and validate its encoded result. */
export function sha256(bytes: Uint8Array): Promise<Sha256Digest> {
  return Effect.runPromise(sha256Effect(bytes));
}

/** Compute a SHA-256 digest in the plugin effect domain. */
export function sha256Effect(bytes: Uint8Array): Effect.Effect<Sha256Digest, PluginError> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return Effect.fail(
      pluginError("crypto_unavailable", "The standards-based crypto API is unavailable."),
    );
  }
  return Effect.gen(function* () {
    const digest = yield* Effect.tryPromise({
      try: () => subtle.digest("SHA-256", toCryptoBuffer(bytes)),
      catch: (error) =>
        pluginError("digest_invalid", "Unable to compute SHA-256 digest.", {}, error),
    });
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const parsed = createSha256Digest(hex);
    if (!parsed.ok)
      return yield* Effect.fail(
        pluginError("digest_invalid", "The crypto API returned an invalid digest."),
      );
    return parsed.value;
  });
}

type DigestFile = Readonly<{
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}>;

function toCryptoBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
