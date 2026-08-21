// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { type CoreResult, CoreError, failure, inputError, success } from "./errors.ts";
import { decodeUnknown } from "./schema.ts";

export const identifierTextSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
);
export const digestTextSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));

const RunIdSchema = identifierTextSchema.pipe(Schema.brand("RunId"));
const ProjectIdSchema = identifierTextSchema.pipe(Schema.brand("ProjectId"));
const TrustIdSchema = identifierTextSchema.pipe(Schema.brand("TrustId"));
const WorkflowIdSchema = identifierTextSchema.pipe(Schema.brand("WorkflowId"));
const Sha256DigestSchema = digestTextSchema.pipe(Schema.brand("Sha256Digest"));

export type RunId = typeof RunIdSchema.Type;
export type ProjectId = typeof ProjectIdSchema.Type;
export type TrustId = typeof TrustIdSchema.Type;
export type WorkflowId = typeof WorkflowIdSchema.Type;
export type Sha256Digest = typeof Sha256DigestSchema.Type;

function createIdentifier<T extends string>(
  schema: Schema.Schema<T, string>,
  value: unknown,
  field: string,
): CoreResult<T> {
  const parsed = decodeUnknown(schema, value);
  if (Either.isLeft(parsed)) {
    return failure(inputError(field, parsed.left));
  }
  // The schema establishes the non-empty, bounded identifier invariant.
  return success(parsed.right);
}

export function createRunId(value: unknown): CoreResult<RunId> {
  return createIdentifier(RunIdSchema, value, "run_id");
}

export function createProjectId(value: unknown): CoreResult<ProjectId> {
  return createIdentifier(ProjectIdSchema, value, "project_id");
}

export function createTrustId(value: unknown): CoreResult<TrustId> {
  return createIdentifier(TrustIdSchema, value, "trust_id");
}

export function createWorkflowId(value: unknown): CoreResult<WorkflowId> {
  return createIdentifier(WorkflowIdSchema, value, "workflow_id");
}

export function createSha256Digest(value: unknown): CoreResult<Sha256Digest> {
  const parsed = decodeUnknown(Sha256DigestSchema, value);
  if (Either.isLeft(parsed)) {
    return failure(inputError("sha256 digest", parsed.left));
  }
  // The schema establishes the exact lowercase 32-byte hexadecimal form.
  return success(parsed.right);
}

export const RunIdentityInputSchema = Schema.Struct({
  run_id: identifierTextSchema,
  objective_lineage: identifierTextSchema,
  parent_run_id: Schema.optional(Schema.Union(identifierTextSchema, Schema.Null)),
});
export type RunIdentityInput = typeof RunIdentityInputSchema.Type;

export const TrustIdentityInputSchema = Schema.Struct({
  project_id: identifierTextSchema,
  trust_id: identifierTextSchema,
  trust_digest: digestTextSchema,
});
export type TrustIdentityInput = typeof TrustIdentityInputSchema.Type;

export const ProjectIdentityInputSchema = Schema.Struct({
  project_id: identifierTextSchema,
  project_digest: digestTextSchema,
});
export type ProjectIdentityInput = typeof ProjectIdentityInputSchema.Type;

export const WorkflowIdentityInputSchema = Schema.Struct({
  workflow_id: identifierTextSchema,
  project_id: identifierTextSchema,
  source_digest: digestTextSchema,
});
export type WorkflowIdentityInput = typeof WorkflowIdentityInputSchema.Type;

export type IdentityRecord =
  | RunIdentityInput
  | TrustIdentityInput
  | ProjectIdentityInput
  | WorkflowIdentityInput;

export const SchemaEpochIdSchema = Schema.String.pipe(Schema.pattern(/^state-[0-9]+\.[0-9]+$/u));
export type SchemaEpochId = typeof SchemaEpochIdSchema.Type;

export function parseIdentityInput(input: unknown): CoreResult<IdentityRecord> {
  const run = decodeUnknown(RunIdentityInputSchema, input);
  if (Either.isRight(run)) {
    return success(run.right);
  }

  const trust = decodeUnknown(TrustIdentityInputSchema, input);
  if (Either.isRight(trust)) {
    return success(trust.right);
  }

  const project = decodeUnknown(ProjectIdentityInputSchema, input);
  if (Either.isRight(project)) {
    return success(project.right);
  }

  const workflow = decodeUnknown(WorkflowIdentityInputSchema, input);
  if (Either.isRight(workflow)) {
    return success(workflow.right);
  }

  return failure(inputError("identity input", workflow.left));
}

export function parseSchemaEpochId(input: unknown): CoreResult<SchemaEpochId> {
  const parsed = decodeUnknown(SchemaEpochIdSchema, input);
  if (Either.isLeft(parsed)) {
    return failure(
      new CoreError(
        "invalid_schema_epoch",
        "Invalid state schema epoch identifier.",
        {
          field: "schema_epoch",
        },
        { cause: parsed.left },
      ),
    );
  }
  return success(parsed.right);
}
