// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";

import type {
  DocumentSymbol,
  Location,
  LocationLink,
  PrepareRenameDefaultBehavior,
  PrepareRenameResult,
  Range,
  SymbolInfo,
  WorkspaceEdit,
} from "./types.ts";
import { decodeLspSchema, isRecord } from "./schema.ts";

const finite = Schema.Number.pipe(Schema.filter((value: number) => Number.isFinite(value)));
export const PositionSchema = Schema.Struct({ line: finite, character: finite });
export const RangeSchema = Schema.Struct({ start: PositionSchema, end: PositionSchema });
export const LocationSchema = Schema.Struct({ uri: Schema.String, range: RangeSchema });
export const LocationLinkSchema = Schema.Struct({
  targetUri: Schema.String,
  targetRange: RangeSchema,
  targetSelectionRange: RangeSchema,
  originSelectionRange: Schema.optional(RangeSchema),
});
export const DiagnosticSchema = Schema.Struct({
  range: RangeSchema,
  severity: Schema.optional(finite),
  code: Schema.optional(Schema.Union(Schema.String, finite)),
  source: Schema.optional(Schema.String),
  message: Schema.String,
});
export const SymbolInfoSchema = Schema.Struct({
  name: Schema.String,
  kind: finite,
  location: LocationSchema,
  containerName: Schema.optional(Schema.String),
});
export const DocumentSymbolSchema: Schema.Schema<DocumentSymbol> = Schema.declare(
  (value: unknown): value is DocumentSymbol => {
    if (!isRecord(value)) return false;
    const record = value;
    if (typeof record["name"] !== "string" || typeof record["kind"] !== "number") return false;
    if (
      decodeLspSchema(RangeSchema, record["range"]) === undefined ||
      decodeLspSchema(RangeSchema, record["selectionRange"]) === undefined
    )
      return false;
    return (
      record["children"] === undefined ||
      (Array.isArray(record["children"]) &&
        record["children"].every((item) => DocumentSymbolGuard(item)))
    );
  },
);
function DocumentSymbolGuard(value: unknown): value is DocumentSymbol {
  return decodeLspSchema(DocumentSymbolSchema, value) !== undefined;
}
const TextEditSchema = Schema.Struct({ range: RangeSchema, newText: Schema.String });
const TextDocumentEditSchema = Schema.Struct({
  textDocument: Schema.Struct({ uri: Schema.String, version: Schema.Union(finite, Schema.Null) }),
  edits: Schema.Array(TextEditSchema),
});
const FileOperationOptionsSchema = Schema.Struct({
  overwrite: Schema.optional(Schema.Boolean),
  ignoreIfExists: Schema.optional(Schema.Boolean),
  recursive: Schema.optional(Schema.Boolean),
  ignoreIfNotExists: Schema.optional(Schema.Boolean),
});
const CreateFileSchema = Schema.Struct({
  kind: Schema.Literal("create"),
  uri: Schema.String,
  options: Schema.optional(FileOperationOptionsSchema),
});
const RenameFileSchema = Schema.Struct({
  kind: Schema.Literal("rename"),
  oldUri: Schema.String,
  newUri: Schema.String,
  options: Schema.optional(FileOperationOptionsSchema),
});
const DeleteFileSchema = Schema.Struct({
  kind: Schema.Literal("delete"),
  uri: Schema.String,
  options: Schema.optional(FileOperationOptionsSchema),
});
export const WorkspaceEditSchema: Schema.Schema<WorkspaceEdit> = Schema.Struct({
  changes: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Array(TextEditSchema) }),
  ),
  documentChanges: Schema.optional(
    Schema.Array(
      Schema.Union(TextDocumentEditSchema, CreateFileSchema, RenameFileSchema, DeleteFileSchema),
    ),
  ),
});
export const DefinitionResultSchema: Schema.Schema<
  Location | LocationLink | readonly (Location | LocationLink)[] | null
> = Schema.Union(
  LocationSchema,
  LocationLinkSchema,
  Schema.Array(Schema.Union(LocationSchema, LocationLinkSchema)),
  Schema.Null,
);
export const ReferencesResultSchema: Schema.Schema<readonly Location[]> = Schema.declare(
  (value: unknown): value is readonly Location[] =>
    value === null ||
    (Array.isArray(value) &&
      value.every((item) => decodeLspSchema(LocationSchema, item) !== undefined)),
);
export const DocumentSymbolsResultSchema: Schema.Schema<readonly (DocumentSymbol | SymbolInfo)[]> =
  Schema.declare(
    (value: unknown): value is readonly (DocumentSymbol | SymbolInfo)[] =>
      value === null ||
      (Array.isArray(value) &&
        value.every(
          (item) =>
            decodeLspSchema(DocumentSymbolSchema, item) !== undefined ||
            decodeLspSchema(SymbolInfoSchema, item) !== undefined,
        )),
  );
export const WorkspaceSymbolsResultSchema: Schema.Schema<readonly SymbolInfo[]> = Schema.declare(
  (value: unknown): value is readonly SymbolInfo[] =>
    value === null ||
    (Array.isArray(value) &&
      value.every((item) => decodeLspSchema(SymbolInfoSchema, item) !== undefined)),
);
export const DiagnosticReportSchema = Schema.Struct({
  items: Schema.optional(Schema.Array(DiagnosticSchema)),
});
export const PrepareRenameResultSchema: Schema.Schema<
  PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null
> = Schema.Union(
  Schema.Struct({ range: RangeSchema, placeholder: Schema.optional(Schema.String) }),
  Schema.Struct({ defaultBehavior: Schema.Boolean }),
  RangeSchema,
  Schema.Null,
);
