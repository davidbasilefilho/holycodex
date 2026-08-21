// SPDX-License-Identifier: Apache-2.0

import {
  createSha256Digest,
  type Sha256Digest,
  canonicalJson,
  sha256DomainDigest,
} from "@holycodex/core";
import {
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  PAYLOAD_MANIFEST_PATH,
  SOURCE_MANIFEST_PATH,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import {
  PayloadIdentitySchema,
  decodeSchema,
  parsePayloadLocation,
  readGeneratedManifest,
  readPayloadManifest,
  declaredSourcePaths,
} from "./schemas.ts";
import {
  compareFiles,
  comparePathText,
  readPayloadFile,
  resolveStagingRoot,
  walkPayload,
} from "./source.ts";
import type { PayloadIdentity, VerifiedPayload } from "./types.ts";

export async function verifyPayload(input: unknown): Promise<VerifiedPayload> {
  const stagingDirectory = parsePayloadLocation(input);
  const root = await resolveStagingRoot(stagingDirectory);
  const payloadManifest = await readPayloadManifest(root);
  const generatedManifest = await readGeneratedManifest(root);
  if (generatedManifest.version !== payloadManifest.version) {
    throw pluginError("payload_invalid", "Generated metadata versions do not match.");
  }
  if (payloadManifest.identity.epoch !== payloadManifest.schema_epoch) {
    throw pluginError("payload_invalid", "Payload identity epoch does not match metadata.");
  }
  const declaredPaths = [...declaredSourcePaths(generatedManifest)].sort(comparePathText);
  const manifestPaths = payloadManifest.files.map((file) => file.path);
  if (
    declaredPaths.length !== manifestPaths.length ||
    declaredPaths.some((path, index) => path !== manifestPaths[index])
  ) {
    throw pluginError(
      "payload_invalid",
      "Generated metadata and the payload file manifest disagree.",
    );
  }

  const expectedPaths = new Set([
    ...payloadManifest.files.map((file) => file.path),
    PAYLOAD_MANIFEST_PATH,
  ]);
  const actualPaths: string[] = [];
  await walkPayload(root, "", actualPaths);
  for (const expectedPath of expectedPaths) {
    if (!actualPaths.includes(expectedPath)) {
      throw pluginError("payload_invalid", "A payload file is missing.", { path: expectedPath });
    }
  }
  for (const actualPath of actualPaths) {
    if (!expectedPaths.has(actualPath)) {
      throw pluginError("payload_invalid", "The payload contains an unexpected file.", {
        path: actualPath,
      });
    }
  }

  const fileBytes = new Map<string, Uint8Array>();
  const payloadMetadataBytes = await readPayloadFile(root, PAYLOAD_MANIFEST_PATH);
  if (payloadMetadataBytes.byteLength > MAX_FILE_SIZE) {
    throw pluginError("payload_invalid", "The payload metadata exceeds the size limit.");
  }
  let totalSize = payloadMetadataBytes.byteLength;
  for (const file of payloadManifest.files) {
    const bytes = await readPayloadFile(root, file.path);
    if (bytes.byteLength !== file.size) {
      throw pluginError("digest_invalid", "A payload file size does not match its manifest.", {
        path: file.path,
      });
    }
    const digest = await sha256(bytes);
    if (digest !== file.sha256) {
      throw pluginError("digest_invalid", "A payload file digest does not match its manifest.", {
        path: file.path,
      });
    }
    totalSize += bytes.byteLength;
    if (bytes.byteLength > MAX_FILE_SIZE || totalSize > MAX_TOTAL_SIZE) {
      throw pluginError("payload_invalid", "The payload exceeds the size limit.");
    }
    fileBytes.set(file.path, bytes);
  }

  const digest = await digestPayload(
    payloadManifest.version,
    payloadManifest.schema_epoch,
    payloadManifest.files,
    async (path) => {
      const bytes = fileBytes.get(path);
      if (!bytes) {
        throw pluginError("payload_invalid", "A payload digest input is missing.", { path });
      }
      return bytes;
    },
  );
  if (digest !== payloadManifest.payload_digest || digest !== payloadManifest.identity.digest) {
    throw pluginError("digest_invalid", "The payload digest does not match its contents.");
  }

  const canonicalMetadata = canonicalJsonBytes(payloadManifest);
  const onDiskMetadata = await readPayloadFile(root, PAYLOAD_MANIFEST_PATH);
  if (!bytesEqual(canonicalMetadata, onDiskMetadata)) {
    throw pluginError("payload_invalid", "Payload metadata is not canonical.");
  }
  const canonicalGenerated = canonicalJsonBytes(generatedManifest);
  const onDiskGenerated = await readPayloadFile(root, SOURCE_MANIFEST_PATH);
  if (!bytesEqual(canonicalGenerated, onDiskGenerated)) {
    throw pluginError("payload_invalid", "Generated plugin metadata is not canonical.");
  }

  return {
    stagingDirectory: root,
    manifest: payloadManifest,
    identity: payloadManifest.identity,
  };
}

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

export async function digestPayload(
  version: string,
  epoch: string,
  files: readonly DigestFile[],
  readBytes: (path: string) => Promise<Uint8Array>,
): Promise<Sha256Digest> {
  const parts: Uint8Array[] = [new TextEncoder().encode(version), new TextEncoder().encode(epoch)];
  for (const file of [...files].sort(compareFiles)) {
    const bytes = await readBytes(file.path);
    const digest = await sha256(bytes);
    if (bytes.byteLength !== file.size || digest !== file.sha256) {
      throw pluginError("source_invalid", "A source file changed during assembly.", {
        path: file.path,
      });
    }
    parts.push(new TextEncoder().encode(file.path), bytes);
  }
  return sha256DomainDigest("plugin-payload", parts);
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

export async function sha256(bytes: Uint8Array): Promise<Sha256Digest> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw pluginError("crypto_unavailable", "The standards-based crypto API is unavailable.");
  }
  const digest = await subtle.digest("SHA-256", toCryptoBuffer(bytes));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const parsed = createSha256Digest(hex);
  if (!parsed.ok) {
    throw pluginError("digest_invalid", "The crypto API returned an invalid digest.");
  }
  return parsed.value;
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
