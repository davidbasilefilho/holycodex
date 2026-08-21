// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import { STATE_SCHEMA_EPOCH, type JsonValue } from "@holycodex/core";
import { join } from "node:path";
import { optionalJsonFile, writeAtomicJson } from "./storage.ts";
import { decodeSchema, DateTextSchema, IdentifierSchema } from "./schema.ts";
import { asJsonValue } from "./json.ts";

const SavedWorkflowSchema = Schema.Struct({
  schema_epoch: Schema.Literal(STATE_SCHEMA_EPOCH),
  scope: Schema.Literal("user", "project"),
  name: IdentifierSchema,
  source: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024 * 1024)),
  project_root: Schema.optional(Schema.String),
  created_at: DateTextSchema,
  updated_at: DateTextSchema,
});
const SavedWorkflowStoreSchema = Schema.Struct({
  schema_epoch: Schema.Literal(STATE_SCHEMA_EPOCH),
  entries: Schema.Array(SavedWorkflowSchema),
});
type SavedWorkflow = typeof SavedWorkflowSchema.Type;
type SavedWorkflowStore = typeof SavedWorkflowStoreSchema.Type;

export async function saveWorkflow(
  stateRoot: string,
  scope: "user" | "project",
  name: string,
  source: string,
  projectRoot: string,
  now: () => Date,
): Promise<JsonValue> {
  const existing = await readStore(stateRoot, scope);
  const previous = existing.entries.find((entry) => entry.name === name);
  const nextEntry: SavedWorkflow = {
    schema_epoch: STATE_SCHEMA_EPOCH,
    scope,
    name,
    source,
    ...(scope === "project" ? { project_root: projectRoot } : {}),
    created_at: previous?.created_at ?? now().toISOString(),
    updated_at: now().toISOString(),
  };
  const parsed = decodeSchema(SavedWorkflowSchema, nextEntry);
  if (!parsed) {
    throw new WorkflowStoreError("workflow_invalid", "The saved workflow is invalid.");
  }
  const entries = [...existing.entries.filter((entry) => entry.name !== name), parsed].sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const store = decodeSchema(SavedWorkflowStoreSchema, {
    schema_epoch: STATE_SCHEMA_EPOCH,
    entries,
  });
  if (!store) {
    throw new WorkflowStoreError("workflow_invalid", "The saved workflow store is invalid.");
  }
  await writeAtomicJson(storePath(stateRoot, scope), asJsonValue(store));
  return asJsonValue(parsed);
}

export async function readSavedWorkflow(
  stateRoot: string,
  scope: "user" | "project",
  name: string,
  projectRoot: string,
): Promise<SavedWorkflow> {
  const store = await readStore(stateRoot, scope);
  const entry = store.entries.find((candidate) => candidate.name === name);
  if (!entry || (scope === "project" && entry.project_root !== projectRoot)) {
    throw new WorkflowStoreError("workflow_missing", "The saved workflow does not exist.");
  }
  return entry;
}

export async function listSavedWorkflows(
  stateRoot: string,
  scope?: "user" | "project",
): Promise<readonly SavedWorkflow[]> {
  const stores =
    scope === undefined
      ? await Promise.all([readStore(stateRoot, "user"), readStore(stateRoot, "project")])
      : [await readStore(stateRoot, scope)];
  return stores.flatMap((store) => store.entries);
}

function storePath(stateRoot: string, scope: "user" | "project"): string {
  return join(stateRoot, "workflows", `${scope}.json`);
}

async function readStore(
  stateRoot: string,
  scope: "user" | "project",
): Promise<SavedWorkflowStore> {
  const store = await optionalJsonFile(storePath(stateRoot, scope), SavedWorkflowStoreSchema);
  return store ?? { schema_epoch: STATE_SCHEMA_EPOCH, entries: [] };
}

export class WorkflowStoreError extends Error {
  readonly code: "workflow_invalid" | "workflow_missing";

  constructor(code: "workflow_invalid" | "workflow_missing", message: string) {
    super(message);
    this.name = "WorkflowStoreError";
    this.code = code;
  }
}
