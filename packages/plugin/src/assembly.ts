// SPDX-License-Identifier: Apache-2.0

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  PAYLOAD_MANIFEST_PATH,
  SOURCE_MANIFEST_PATH,
} from "./constants.ts";
import { pluginError } from "./errors.ts";
import { decodeSchema, PayloadManifestSchema, parseAssemblyRequest } from "./schemas.ts";
import { planAssembly } from "./planning.ts";
import { comparePathText, readSourceFile, resolveStagingRoot } from "./source.ts";
import { canonicalJsonBytes, sha256, verifyPayload } from "./verification.ts";
import type { AssembledPayload, AssemblyPlan, PayloadManifest } from "./types.ts";

export async function assemblePayload(input: unknown): Promise<AssembledPayload> {
  const request = parseAssemblyRequest(input);
  const plan = await planAssembly(request);
  await assertSafeStaging(plan.sourceRoot, plan.stagingDirectory);
  await ensureEmptyStagingDirectory(plan.stagingDirectory);

  const stagedBytes = new Map<string, Uint8Array>();
  const manifestBytes = canonicalJsonBytes(plan.manifest);
  stagedBytes.set(SOURCE_MANIFEST_PATH, manifestBytes);
  for (const file of plan.files) {
    if (file.path === SOURCE_MANIFEST_PATH) {
      continue;
    }
    stagedBytes.set(file.path, await readSourceFile(plan.sourceRoot, file.path));
  }

  const payloadManifest = await createPayloadManifest(plan, stagedBytes);
  const payloadManifestBytes = canonicalJsonBytes(payloadManifest);
  if (payloadManifestBytes.byteLength > MAX_FILE_SIZE) {
    throw pluginError("payload_invalid", "The generated payload metadata exceeds the size limit.");
  }
  if (
    plan.files.reduce((total, file) => total + file.size, payloadManifestBytes.byteLength) >
    MAX_TOTAL_SIZE
  ) {
    throw pluginError("payload_invalid", "The generated payload exceeds the total size limit.");
  }
  stagedBytes.set(PAYLOAD_MANIFEST_PATH, payloadManifestBytes);
  for (const [path, bytes] of [...stagedBytes.entries()].sort(([left], [right]) =>
    comparePathText(left, right),
  )) {
    await writeStagedFile(plan.stagingDirectory, path, bytes);
  }

  const verified = await verifyPayload(plan.stagingDirectory);
  return { ...verified, plan };
}

async function createPayloadManifest(
  plan: AssemblyPlan,
  stagedBytes: ReadonlyMap<string, Uint8Array>,
): Promise<PayloadManifest> {
  for (const file of plan.files) {
    const bytes = stagedBytes.get(file.path);
    if (!bytes || bytes.byteLength !== file.size || (await sha256(bytes)) !== file.sha256) {
      throw pluginError("payload_invalid", "A staged file does not match the assembly plan.", {
        path: file.path,
      });
    }
  }
  const files = plan.files.map((file) => ({
    path: file.path,
    size: file.size,
    sha256: file.sha256,
  }));
  const manifest = {
    schema_epoch: plan.schemaEpoch,
    version: plan.version,
    files,
    payload_digest: plan.payloadDigest,
    identity: plan.identity,
  };
  const parsed = decodeSchema(PayloadManifestSchema, manifest);
  if (parsed === undefined) {
    throw pluginError("payload_invalid", "The generated payload manifest is invalid.", {
      summary: "Effect Schema rejected the generated payload manifest.",
      staged_files: stagedBytes.size,
    });
  }
  return parsed;
}

async function assertSafeStaging(sourceRoot: string, stagingDirectory: string): Promise<void> {
  const sourceRelative = relative(sourceRoot, stagingDirectory);
  if (sourceRelative === "" || (!sourceRelative.startsWith("..") && !isAbsolute(sourceRelative))) {
    throw pluginError(
      "staging_invalid",
      "The staging directory must be outside the plugin source root.",
    );
  }
}

async function ensureEmptyStagingDirectory(stagingDirectory: string): Promise<void> {
  await mkdir(stagingDirectory, { recursive: true });
  const root = await resolveStagingRoot(stagingDirectory);
  const entries = await readdir(root);
  if (entries.length !== 0) {
    throw pluginError("staging_invalid", "The staging directory must be empty.");
  }
}

async function writeStagedFile(root: string, path: string, bytes: Uint8Array): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
