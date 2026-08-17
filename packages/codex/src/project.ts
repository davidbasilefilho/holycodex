// SPDX-License-Identifier: Apache-2.0

import { realpath, stat } from "node:fs/promises";
import { type } from "arktype";
import {
  canonicalIdentityUtf8,
  createProjectId,
  createTrustId,
  domainSeparatedSha256,
  type ProjectId,
  type Sha256Digest,
  type TrustId,
} from "@holycodex/core";
import { CodexError, checked, sanitizeText, TextSchema } from "./common";

export const ProjectTrustInputSchema = type({
  "+": "reject",
  root: TextSchema,
  trustEpoch: TextSchema,
  trustFingerprint: TextSchema,
});
export type ProjectTrustInput = typeof ProjectTrustInputSchema.infer;

export interface ProjectTrustIdentity {
  readonly root: string;
  readonly trustEpoch: string;
  readonly trustFingerprint: string;
  readonly projectId: ProjectId;
  readonly projectDigest: Sha256Digest;
  readonly trustId: TrustId;
  readonly trustDigest: Sha256Digest;
}

export async function createProjectTrustIdentity(
  input: ProjectTrustInput,
): Promise<ProjectTrustIdentity> {
  const validated = checked(ProjectTrustInputSchema, input, "project trust input");
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(validated.root);
    if (!(await stat(canonicalRoot)).isDirectory()) {
      throw new Error("root is not a directory");
    }
  } catch (error: unknown) {
    throw new CodexError(
      "invalid_project_root",
      "The project root is missing or ambiguous.",
      {
        root: sanitizeText(validated.root),
      },
      { cause: error },
    );
  }
  const rootBytes = new TextEncoder().encode(canonicalRoot);
  const projectDigest = await domainSeparatedSha256("codex-project-root", [rootBytes]);
  const projectIdResult = createProjectId(projectDigest);
  if (!projectIdResult.ok) {
    throw new CodexError("invalid_project_root", "The project identity could not be created.");
  }
  const trustDigest = await domainSeparatedSha256("codex-project-trust", [
    rootBytes,
    new TextEncoder().encode(validated.trustEpoch),
    new TextEncoder().encode(validated.trustFingerprint),
    canonicalIdentityUtf8({ project_id: projectIdResult.value, project_digest: projectDigest }),
  ]);
  const trustIdResult = createTrustId(trustDigest);
  if (!trustIdResult.ok) {
    throw new CodexError("invalid_project_root", "The trust identity could not be created.");
  }
  return {
    root: canonicalRoot,
    trustEpoch: validated.trustEpoch,
    trustFingerprint: validated.trustFingerprint,
    projectId: projectIdResult.value,
    projectDigest,
    trustId: trustIdResult.value,
    trustDigest,
  };
}
