import { z } from "zod";

import type {
  Diagnostic,
  DocumentSymbol,
  Location,
  LocationLink,
  PrepareRenameDefaultBehavior,
  PrepareRenameResult,
  Range,
  SymbolInfo,
  WorkspaceEdit,
} from "./types.js";

export const PositionSchema = z.looseObject({ line: z.number(), character: z.number() });
export const RangeSchema: z.ZodType<Range> = z.looseObject({
  start: PositionSchema,
  end: PositionSchema,
});
export const LocationSchema: z.ZodType<Location> = z.looseObject({
  uri: z.string(),
  range: RangeSchema,
});
export const LocationLinkSchema: z.ZodType<LocationLink> = z
  .looseObject({
    targetUri: z.string(),
    targetRange: RangeSchema,
    targetSelectionRange: RangeSchema,
    originSelectionRange: RangeSchema.optional(),
  })
  .transform((value) => ({
    targetUri: value.targetUri,
    targetRange: value.targetRange,
    targetSelectionRange: value.targetSelectionRange,
    ...(value.originSelectionRange === undefined
      ? {}
      : { originSelectionRange: value.originSelectionRange }),
  }));
export const DiagnosticSchema: z.ZodType<Diagnostic> = z
  .looseObject({
    range: RangeSchema,
    severity: z.number().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    source: z.string().optional(),
    message: z.string(),
  })
  .transform((value) => ({
    range: value.range,
    message: value.message,
    ...(value.severity === undefined ? {} : { severity: value.severity }),
    ...(value.code === undefined ? {} : { code: value.code }),
    ...(value.source === undefined ? {} : { source: value.source }),
  }));
export const SymbolInfoSchema: z.ZodType<SymbolInfo> = z
  .looseObject({
    name: z.string(),
    kind: z.number(),
    location: LocationSchema,
    containerName: z.string().optional(),
  })
  .transform((value) => ({
    name: value.name,
    kind: value.kind,
    location: value.location,
    ...(value.containerName === undefined ? {} : { containerName: value.containerName }),
  }));
export const DocumentSymbolSchema: z.ZodType<DocumentSymbol> = z.lazy(() =>
  z
    .looseObject({
      name: z.string(),
      kind: z.number(),
      range: RangeSchema,
      selectionRange: RangeSchema,
      children: z.array(DocumentSymbolSchema).optional(),
    })
    .transform((value) => ({
      name: value.name,
      kind: value.kind,
      range: value.range,
      selectionRange: value.selectionRange,
      ...(value.children === undefined ? {} : { children: value.children }),
    })),
);

const TextEditSchema = z.looseObject({ range: RangeSchema, newText: z.string() });
const TextDocumentEditSchema = z.looseObject({
  textDocument: z.looseObject({ uri: z.string(), version: z.number().nullable() }),
  edits: z.array(TextEditSchema),
});
const CreateFileSchema = z.looseObject({ kind: z.literal("create"), uri: z.string() });
const RenameFileSchema = z.looseObject({
  kind: z.literal("rename"),
  oldUri: z.string(),
  newUri: z.string(),
});
const DeleteFileSchema = z.looseObject({ kind: z.literal("delete"), uri: z.string() });
export const WorkspaceEditSchema: z.ZodType<WorkspaceEdit> = z
  .looseObject({
    changes: z.record(z.string(), z.array(TextEditSchema)).optional(),
    documentChanges: z
      .array(
        z.union([TextDocumentEditSchema, CreateFileSchema, RenameFileSchema, DeleteFileSchema]),
      )
      .optional(),
  })
  .transform((value) => ({
    ...(value.changes === undefined ? {} : { changes: value.changes }),
    ...(value.documentChanges === undefined ? {} : { documentChanges: value.documentChanges }),
  }));

export const DefinitionResultSchema = z
  .union([
    LocationSchema,
    LocationLinkSchema,
    z.array(z.union([LocationSchema, LocationLinkSchema])),
  ])
  .nullable();
function nullableArray<T>(item: z.ZodType<T>): z.ZodType<T[]> {
  return z
    .array(item)
    .nullable()
    .transform((value) => value ?? []);
}

export const ReferencesResultSchema = nullableArray(LocationSchema);
export const DocumentSymbolsResultSchema = nullableArray(
  z.union([DocumentSymbolSchema, SymbolInfoSchema]),
);
export const WorkspaceSymbolsResultSchema = nullableArray(SymbolInfoSchema);
export const DiagnosticReportSchema = z.looseObject({
  items: z.array(DiagnosticSchema).optional(),
});
export const PrepareRenameResultSchema: z.ZodType<
  PrepareRenameResult | PrepareRenameDefaultBehavior | Range | null
> = z
  .union([
    z
      .looseObject({ range: RangeSchema, placeholder: z.string().optional() })
      .transform((value) => ({
        range: value.range,
        ...(value.placeholder === undefined ? {} : { placeholder: value.placeholder }),
      })),
    z.looseObject({ defaultBehavior: z.boolean() }),
    RangeSchema,
  ])
  .nullable();
