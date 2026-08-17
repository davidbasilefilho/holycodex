// SPDX-License-Identifier: Apache-2.0

import { type } from "arktype";
import { type CoreResult, CoreError, failure, inputError, success } from "./errors.ts";

export const identifierTextSchema = type(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const digestTextSchema = type(/^[0-9a-f]{64}$/u);

declare const runIdBrand: unique symbol;
declare const projectIdBrand: unique symbol;
declare const trustIdBrand: unique symbol;
declare const workflowIdBrand: unique symbol;
declare const digestBrand: unique symbol;

export type RunId = string & { readonly [runIdBrand]: true };
export type ProjectId = string & { readonly [projectIdBrand]: true };
export type TrustId = string & { readonly [trustIdBrand]: true };
export type WorkflowId = string & { readonly [workflowIdBrand]: true };
export type Sha256Digest = string & { readonly [digestBrand]: true };

function createIdentifier<T extends string>(
  value: unknown,
  field: string,
  brand: (value: string) => T,
): CoreResult<T> {
  const parsed = identifierTextSchema(value);
  if (parsed instanceof type.errors) {
    return failure(inputError(field, parsed));
  }
  // The schema establishes the non-empty, bounded identifier invariant.
  return success(brand(parsed));
}

export function createRunId(value: unknown): CoreResult<RunId> {
  return createIdentifier(value, "run_id", (parsed) => parsed as RunId);
}

export function createProjectId(value: unknown): CoreResult<ProjectId> {
  return createIdentifier(value, "project_id", (parsed) => parsed as ProjectId);
}

export function createTrustId(value: unknown): CoreResult<TrustId> {
  return createIdentifier(value, "trust_id", (parsed) => parsed as TrustId);
}

export function createWorkflowId(value: unknown): CoreResult<WorkflowId> {
  return createIdentifier(value, "workflow_id", (parsed) => parsed as WorkflowId);
}

export function createSha256Digest(value: unknown): CoreResult<Sha256Digest> {
  const parsed = digestTextSchema(value);
  if (parsed instanceof type.errors) {
    return failure(inputError("sha256 digest", parsed));
  }
  // The schema establishes the exact lowercase 32-byte hexadecimal form.
  return success(parsed as Sha256Digest);
}

export const RunIdentityInputSchema = type({
  "+": "reject",
  run_id: identifierTextSchema,
  objective_lineage: identifierTextSchema,
  "parent_run_id?": identifierTextSchema.or("null"),
});
export type RunIdentityInput = typeof RunIdentityInputSchema.infer;

export const TrustIdentityInputSchema = type({
  "+": "reject",
  project_id: identifierTextSchema,
  trust_id: identifierTextSchema,
  trust_digest: digestTextSchema,
});
export type TrustIdentityInput = typeof TrustIdentityInputSchema.infer;

export const ProjectIdentityInputSchema = type({
  "+": "reject",
  project_id: identifierTextSchema,
  project_digest: digestTextSchema,
});
export type ProjectIdentityInput = typeof ProjectIdentityInputSchema.infer;

export const WorkflowIdentityInputSchema = type({
  "+": "reject",
  workflow_id: identifierTextSchema,
  project_id: identifierTextSchema,
  source_digest: digestTextSchema,
});
export type WorkflowIdentityInput = typeof WorkflowIdentityInputSchema.infer;

export type IdentityRecord =
  | RunIdentityInput
  | TrustIdentityInput
  | ProjectIdentityInput
  | WorkflowIdentityInput;

export const SchemaEpochIdSchema = type(/^state-[0-9]+\.[0-9]+$/u);
export type SchemaEpochId = typeof SchemaEpochIdSchema.infer;

export function parseIdentityInput(input: unknown): CoreResult<IdentityRecord> {
  const run = RunIdentityInputSchema(input);
  if (!(run instanceof type.errors)) {
    return success(run);
  }

  const trust = TrustIdentityInputSchema(input);
  if (!(trust instanceof type.errors)) {
    return success(trust);
  }

  const project = ProjectIdentityInputSchema(input);
  if (!(project instanceof type.errors)) {
    return success(project);
  }

  const workflow = WorkflowIdentityInputSchema(input);
  if (!(workflow instanceof type.errors)) {
    return success(workflow);
  }

  return failure(inputError("identity input", workflow));
}

export function parseSchemaEpochId(input: unknown): CoreResult<SchemaEpochId> {
  const parsed = SchemaEpochIdSchema(input);
  if (parsed instanceof type.errors) {
    return failure(
      new CoreError(
        "invalid_schema_epoch",
        "Invalid state schema epoch identifier.",
        {
          field: "schema_epoch",
        },
        { cause: parsed },
      ),
    );
  }
  return success(parsed);
}
