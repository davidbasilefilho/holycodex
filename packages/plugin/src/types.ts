// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@holycodex/core";

import type {
  AssemblyRequest as ParsedAssemblyRequest,
  GeneratedManifest,
  PayloadFile,
  PayloadIdentity,
  PayloadManifest,
  SourceManifest,
} from "./schemas.ts";

/** Validated options used to plan and assemble a plugin payload. */
export type AssemblyRequest = ParsedAssemblyRequest;
export type { PayloadFile, PayloadIdentity, PayloadManifest, SourceManifest, GeneratedManifest };
/** Generated plugin manifest type exposed under its plugin-specific name. */
export type GeneratedPluginManifest = GeneratedManifest;
/** Identity shared by a payload manifest and its assembled artifact. */
export type ArtifactIdentity = PayloadIdentity;

/** File metadata recorded while validating the plugin source tree. */
export interface SourceFile {
  /** Safe path of the file relative to the source root. */
  readonly path: string;
  /** File length in bytes. */
  readonly size: number;
  /** SHA-256 digest of the file contents. */
  readonly sha256: Sha256Digest;
}

/** Validated plugin source manifest and the files selected for packaging. */
export interface SourceValidation {
  /** Resolved root directory from which source files were read. */
  readonly sourceRoot: string;
  /** Validated source plugin manifest. */
  readonly manifest: SourceManifest;
  /** Source file metadata in deterministic path order. */
  readonly files: readonly SourceFile[];
}

/** Deterministic payload assembly plan, including its computed identity. */
export interface AssemblyPlan {
  /** Resolved root directory of the plugin source assets. */
  readonly sourceRoot: string;
  /** Directory where the payload will be staged. */
  readonly stagingDirectory: string;
  /** Canonical package version embedded in the payload. */
  readonly version: string;
  /** Payload schema epoch used to interpret its manifest. */
  readonly schemaEpoch: string;
  /** Generated plugin manifest to write into the payload. */
  readonly manifest: GeneratedManifest;
  /** Source files and digests selected for inclusion. */
  readonly files: readonly SourceFile[];
  /** Digest of the complete payload file set. */
  readonly payloadDigest: Sha256Digest;
  /** Version, digest, and epoch identifying this payload. */
  readonly identity: PayloadIdentity;
}

/** Payload directory and integrity metadata after successful readback verification. */
export interface VerifiedPayload {
  /** Directory containing the verified staged payload. */
  readonly stagingDirectory: string;
  /** Validated payload manifest read from the staging directory. */
  readonly manifest: PayloadManifest;
  /** Identity recomputed and verified from the staged files. */
  readonly identity: PayloadIdentity;
}

/** Verified payload together with the plan used to assemble it. */
export interface AssembledPayload extends VerifiedPayload {
  /** Original deterministic assembly plan. */
  readonly plan: AssemblyPlan;
}
