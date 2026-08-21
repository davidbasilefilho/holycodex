// SPDX-License-Identifier: Apache-2.0

import * as Either from "effect/Either";
import * as Schema from "effect/Schema";
import { decodeUnknown, STATE_SCHEMA_EPOCH } from "@holycodex/core";
import type { Refinement } from "@holycodex/workflow-host";
import { RefinementSchema } from "@holycodex/workflow-host";
import { join } from "node:path";
import { optionalJsonFile, writeAtomicJson } from "./storage.ts";
import { asJsonValue } from "./json.ts";

const RefinementStoreSchema = Schema.Struct({
  schema_epoch: Schema.Literal(STATE_SCHEMA_EPOCH),
  entries: Schema.Array(RefinementSchema),
});
type RefinementStore = typeof RefinementStoreSchema.Type;

export async function listRefinements(stateRoot: string): Promise<readonly Refinement[]> {
  return (await readStore(stateRoot)).entries;
}

export async function findRefinement(stateRoot: string, id: string): Promise<Refinement> {
  const entry = (await readStore(stateRoot)).entries.find(
    (candidate) => candidate.refinement_id === id,
  );
  if (!entry)
    throw new RefinementStoreError("refinement_missing", "The refinement does not exist.");
  return entry;
}

export async function replaceRefinement(
  stateRoot: string,
  refinement: Refinement,
): Promise<Refinement> {
  const store = await readStore(stateRoot);
  const entries = [
    ...store.entries.filter((entry) => entry.refinement_id !== refinement.refinement_id),
    refinement,
  ].sort((left, right) => left.refinement_id.localeCompare(right.refinement_id));
  const next = decodeStore({ schema_epoch: STATE_SCHEMA_EPOCH, entries });
  if (!next) throw new RefinementStoreError("refinement_invalid", "The refinement is invalid.");
  await writeAtomicJson(storePath(stateRoot), asJsonValue(next));
  return refinement;
}

async function readStore(stateRoot: string): Promise<RefinementStore> {
  const parsed = await optionalJsonFile(storePath(stateRoot), RefinementStoreSchema);
  return parsed ?? { schema_epoch: STATE_SCHEMA_EPOCH, entries: [] };
}

function decodeStore(input: unknown): RefinementStore | undefined {
  const parsed = decodeUnknown(RefinementStoreSchema, input);
  return Either.isRight(parsed) ? parsed.right : undefined;
}

function storePath(stateRoot: string): string {
  return join(stateRoot, "refinements.json");
}

export class RefinementStoreError extends Error {
  readonly code: "refinement_missing" | "refinement_invalid";

  constructor(code: "refinement_missing" | "refinement_invalid", message: string) {
    super(message);
    this.name = "RefinementStoreError";
    this.code = code;
  }
}
