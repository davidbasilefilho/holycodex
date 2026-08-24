// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";

export const SAFE_FILESYSTEM_PROTOCOL_VERSION = 1 as const;
export const SAFE_FILESYSTEM_HELPER_VERSION = "safe-filesystem-helper-1" as const;
export const SAFE_FILESYSTEM_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const SAFE_FILESYSTEM_MAX_FILE_BYTES = 1024 * 1024;
export const SAFE_FILESYSTEM_MAX_DATA_BYTES = Math.ceil(SAFE_FILESYSTEM_MAX_FILE_BYTES / 3) * 4;

export const SafeFilesystemOperationSchema = Schema.Literal(
  "version",
  "ensureRoot",
  "createSessionDir",
  "atomicWrite",
  "readFile",
  "statDigest",
  "listDirectory",
  "removeSessionTree",
);
export type SafeFilesystemOperation = typeof SafeFilesystemOperationSchema.Type;

export const SafeFilesystemErrorCodeSchema = Schema.Literal(
  "invalid_input",
  "invalid_path",
  "path_escape",
  "not_found",
  "not_directory",
  "not_regular_file",
  "link_reparse",
  "already_exists",
  "conflict",
  "root_identity",
  "integrity_uncertain",
  "io_error",
  "protocol_error",
  "capability_unavailable",
);
export type SafeFilesystemErrorCode = typeof SafeFilesystemErrorCodeSchema.Type;

export const SafeFilesystemDigestSchema = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/u));
export const SafeFilesystemRootIdentitySchema = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9:_-]{1,191}$/u),
);

export const SafeFilesystemRequestSchema = Schema.Struct({
  version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  op: SafeFilesystemOperationSchema,
  root: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096))),
  target: Schema.optional(Schema.String.pipe(Schema.maxLength(4096))),
  root_identity: Schema.optional(SafeFilesystemRootIdentitySchema),
  allow_missing: Schema.optional(Schema.Boolean),
  data: Schema.optional(
    Schema.String.pipe(
      Schema.maxLength(SAFE_FILESYSTEM_MAX_DATA_BYTES),
      Schema.pattern(/^[A-Za-z0-9+/]*={0,2}$/u),
    ),
  ),
  expected_digest: Schema.optional(SafeFilesystemDigestSchema),
});
export type SafeFilesystemRequest = typeof SafeFilesystemRequestSchema.Type;

export const SafeFilesystemErrorResponseSchema = Schema.Struct({
  version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  ok: Schema.Literal(false),
  op: SafeFilesystemOperationSchema,
  code: SafeFilesystemErrorCodeSchema,
  message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024)),
});

export const SafeFilesystemVersionResponseSchema = Schema.Struct({
  version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  ok: Schema.Literal(true),
  op: Schema.Literal("version"),
  helper_version: Schema.Literal(SAFE_FILESYSTEM_HELPER_VERSION),
  protocol_version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  source_sha256: SafeFilesystemDigestSchema,
});

export const SafeFilesystemMutationResponseSchema = Schema.Struct({
  version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  ok: Schema.Literal(true),
  op: Schema.Literal("ensureRoot", "createSessionDir", "atomicWrite", "removeSessionTree"),
  changed: Schema.Boolean,
  root_identity: Schema.optional(SafeFilesystemRootIdentitySchema),
  digest: Schema.optional(SafeFilesystemDigestSchema),
});

export const SafeFilesystemStatResponseSchema = Schema.Struct({
  version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  ok: Schema.Literal(true),
  op: Schema.Literal("statDigest"),
  exists: Schema.Boolean,
  kind: Schema.Literal("missing", "file", "directory", "symlink", "other"),
  size: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  root_identity: Schema.optional(SafeFilesystemRootIdentitySchema),
  digest: Schema.String.pipe(Schema.pattern(/^(?:[a-f0-9]{64})?$/u)),
});

export const SafeFilesystemReadResponseSchema = Schema.Struct({
  version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  ok: Schema.Literal(true),
  op: Schema.Literal("readFile"),
  size: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  digest: SafeFilesystemDigestSchema,
  data: Schema.String.pipe(Schema.maxLength(SAFE_FILESYSTEM_MAX_LINE_BYTES)),
});

export const SafeFilesystemDirectoryEntrySchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(96)),
  kind: Schema.Literal("file", "directory", "symlink", "other"),
});
export type SafeFilesystemDirectoryEntry = typeof SafeFilesystemDirectoryEntrySchema.Type;

export const SafeFilesystemListResponseSchema = Schema.Struct({
  version: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  ok: Schema.Literal(true),
  op: Schema.Literal("listDirectory"),
  entries: Schema.Array(SafeFilesystemDirectoryEntrySchema).pipe(Schema.maxItems(4096)),
});

export const SafeFilesystemManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal("holycodex-safe-filesystem-artifact-v1"),
  protocolVersion: Schema.Literal(SAFE_FILESYSTEM_PROTOCOL_VERSION),
  helperVersion: Schema.Literal(SAFE_FILESYSTEM_HELPER_VERSION),
  platform: Schema.Literal("linux", "win32"),
  architecture: Schema.Literal("x64"),
  executable: Schema.String.pipe(Schema.pattern(/^safe-filesystem(?:\.exe)?$/u)),
  sourceSha256: SafeFilesystemDigestSchema,
  helperSha256: SafeFilesystemDigestSchema,
  compiler: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  compilerVersion: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4096)),
  flags: Schema.Array(Schema.String.pipe(Schema.minLength(1))).pipe(Schema.minItems(1)),
});
export type SafeFilesystemManifest = typeof SafeFilesystemManifestSchema.Type;

export function encodeRequest(value: unknown): string {
  const decoded = Schema.decodeUnknownEither(SafeFilesystemRequestSchema, {
    onExcessProperty: "error",
  })(value);
  if (Either.isLeft(decoded)) {
    throw new Error(`Safe filesystem request is invalid: ${String(decoded.left)}`);
  }
  if (decoded.right.data !== undefined && decoded.right.data.length % 4 !== 0) {
    throw new Error("Safe filesystem request data must use complete base64 quartets.");
  }
  const line = `${JSON.stringify(decoded.right)}\n`;
  if (new TextEncoder().encode(line).byteLength > SAFE_FILESYSTEM_MAX_LINE_BYTES) {
    throw new Error("Safe filesystem request exceeds the protocol size limit.");
  }
  return line;
}

export type SafeFilesystemDecodedResponse =
  | typeof SafeFilesystemErrorResponseSchema.Type
  | typeof SafeFilesystemVersionResponseSchema.Type
  | typeof SafeFilesystemMutationResponseSchema.Type
  | typeof SafeFilesystemStatResponseSchema.Type
  | typeof SafeFilesystemReadResponseSchema.Type
  | typeof SafeFilesystemListResponseSchema.Type;

export function decodeResponse(value: unknown): SafeFilesystemDecodedResponse {
  const options = { onExcessProperty: "error" } as const;
  const error = Schema.decodeUnknownEither(SafeFilesystemErrorResponseSchema, options)(value);
  if (Either.isRight(error)) return error.right;
  const version = Schema.decodeUnknownEither(SafeFilesystemVersionResponseSchema, options)(value);
  if (Either.isRight(version)) return version.right;
  const mutation = Schema.decodeUnknownEither(SafeFilesystemMutationResponseSchema, options)(value);
  if (Either.isRight(mutation)) return mutation.right;
  const stat = Schema.decodeUnknownEither(SafeFilesystemStatResponseSchema, options)(value);
  if (Either.isRight(stat)) return stat.right;
  const read = Schema.decodeUnknownEither(SafeFilesystemReadResponseSchema, options)(value);
  if (Either.isRight(read)) return read.right;
  const list = Schema.decodeUnknownEither(SafeFilesystemListResponseSchema, options)(value);
  if (Either.isRight(list)) return list.right;
  throw new Error("Safe filesystem helper returned an invalid protocol response.");
}
