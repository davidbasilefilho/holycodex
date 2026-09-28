// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

import { type CoreResult, CoreError, failure, inputError, success } from "./errors.ts";
import { decodeUnknown } from "./schema.ts";

/** Runtime schema validating identifier text values at the receiving boundary. */
export const identifierTextSchema = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
);
/** Runtime schema validating digest text values at the receiving boundary. */
export const digestTextSchema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));

const RunIdSchema = identifierTextSchema.pipe(Schema.brand("RunId"));
const ProjectIdSchema = identifierTextSchema.pipe(Schema.brand("ProjectId"));
const TrustIdSchema = identifierTextSchema.pipe(Schema.brand("TrustId"));
const Sha256DigestSchema = digestTextSchema.pipe(Schema.brand("Sha256Digest"));

/** Type representing run id in the core domain. */
export type RunId = typeof RunIdSchema.Type;
/** Type representing project id in the core domain. */
export type ProjectId = typeof ProjectIdSchema.Type;
/** Type representing trust id in the core domain. */
export type TrustId = typeof TrustIdSchema.Type;
/** Type representing sha256 digest in the core domain. */
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

/** Validate an unknown value as a bounded run identifier. */
export function createRunId(value: unknown): CoreResult<RunId> {
  return createIdentifier(RunIdSchema, value, "run_id");
}

/** Validate an unknown value as a bounded project identifier. */
export function createProjectId(value: unknown): CoreResult<ProjectId> {
  return createIdentifier(ProjectIdSchema, value, "project_id");
}

/** Validate an unknown value as a bounded trust identifier. */
export function createTrustId(value: unknown): CoreResult<TrustId> {
  return createIdentifier(TrustIdSchema, value, "trust_id");
}

/** Validate an unknown value as a lowercase 64-character SHA-256 digest. */
export function createSha256Digest(value: unknown): CoreResult<Sha256Digest> {
  const parsed = decodeUnknown(Sha256DigestSchema, value);
  if (Either.isLeft(parsed)) {
    return failure(inputError("sha256 digest", parsed.left));
  }
  // The schema establishes the exact lowercase 32-byte hexadecimal form.
  return success(parsed.right);
}

/** Runtime schema validating run identity input values at the receiving boundary. */
export const RunIdentityInputSchema = Schema.Struct({
  run_id: identifierTextSchema,
  objective_lineage: identifierTextSchema,
  parent_run_id: Schema.optional(Schema.Union(identifierTextSchema, Schema.Null)),
});
/** Type representing run identity input in the core domain. */
export type RunIdentityInput = typeof RunIdentityInputSchema.Type;

/** Runtime schema validating trust identity input values at the receiving boundary. */
export const TrustIdentityInputSchema = Schema.Struct({
  project_id: identifierTextSchema,
  trust_id: identifierTextSchema,
  trust_digest: digestTextSchema,
});
/** Type representing trust identity input in the core domain. */
export type TrustIdentityInput = typeof TrustIdentityInputSchema.Type;

/** Runtime schema validating project identity input values at the receiving boundary. */
export const ProjectIdentityInputSchema = Schema.Struct({
  project_id: identifierTextSchema,
  project_digest: digestTextSchema,
});
/** Type representing project identity input in the core domain. */
export type ProjectIdentityInput = typeof ProjectIdentityInputSchema.Type;

/** Type representing identity record in the core domain. */
export type IdentityRecord = RunIdentityInput | TrustIdentityInput | ProjectIdentityInput;

/** Runtime schema validating schema epoch id values at the receiving boundary. */
export const SchemaEpochIdSchema = Schema.String.pipe(Schema.pattern(/^state-[0-9]+\.[0-9]+$/u));
/** Type representing schema epoch id in the core domain. */
export type SchemaEpochId = typeof SchemaEpochIdSchema.Type;

/** Decode an unknown value as one of the supported run, trust, or project identities. */
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

  return failure(inputError("identity input", project.left));
}

/** Validate an unknown value as a state schema epoch identifier. */
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
