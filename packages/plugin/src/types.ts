// SPDX-License-Identifier: Apache-2.0

import type { Sha256Digest } from "@holycodex/core";
import type {
  AssemblyRequest as ParsedAssemblyRequest,
  GeneratedManifest,
  PonytailMetadata,
  PayloadFile,
  PayloadIdentity,
  PayloadManifest,
  SourceManifest,
} from "./schemas.ts";

export type AssemblyRequest = ParsedAssemblyRequest;
export type {
  PayloadFile,
  PayloadIdentity,
  PayloadManifest,
  PonytailMetadata,
  SourceManifest,
  GeneratedManifest,
};
export type GeneratedPluginManifest = GeneratedManifest;
export type ArtifactIdentity = PayloadIdentity;

export interface SourceFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: Sha256Digest;
}

export interface SourceValidation {
  readonly sourceRoot: string;
  readonly manifest: SourceManifest;
  readonly files: readonly SourceFile[];
}

export interface AssemblyPlan {
  readonly sourceRoot: string;
  readonly stagingDirectory: string;
  readonly version: string;
  readonly schemaEpoch: string;
  readonly manifest: GeneratedManifest;
  readonly files: readonly SourceFile[];
  readonly payloadDigest: Sha256Digest;
  readonly identity: PayloadIdentity;
}

export interface VerifiedPayload {
  readonly stagingDirectory: string;
  readonly manifest: PayloadManifest;
  readonly identity: PayloadIdentity;
}

export interface AssembledPayload extends VerifiedPayload {
  readonly plan: AssemblyPlan;
}
