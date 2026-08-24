// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import * as Schema from "effect/Schema";

import { contextEnv } from "../request-context.ts";
import { decodeLspSchema } from "./schema.ts";

const DecisionSchema = Schema.Literal("declined", "allowed");
const RecordSchema = Schema.Struct({ decision: DecisionSchema, decidedAt: Schema.String });
const DecisionsSchema = Schema.Record({ key: Schema.String, value: RecordSchema });
export type InstallDecision = typeof DecisionSchema.Type;
export type InstallDecisionRecord = typeof RecordSchema.Type;

/** Resolves the user-owned install-decision file. */
export function getInstallDecisionsPath(): string {
  const override = contextEnv("HOLYCODEX_LSP_INSTALL_DECISIONS");
  if (override === undefined) return join(homedir(), ".codex", "lsp-install-decisions.json");
  return isAbsolute(override) ? override : join(homedir(), override);
}

/** Loads valid persisted install decisions and ignores malformed records. */
export function loadInstallDecisions(): Readonly<Record<string, InstallDecisionRecord>> {
  const path = getInstallDecisionsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return decodeLspSchema(DecisionsSchema, parsed) ?? {};
  } catch {
    return {};
  }
}

/** Returns one persisted decision, if valid. */
export function loadInstallDecision(serverId: string): InstallDecisionRecord | undefined {
  return loadInstallDecisions()[serverId];
}

/** Records a decision atomically in the user-owned configuration area. */
export function recordInstallDecision(
  serverId: string,
  decision: InstallDecision,
  decidedAt = new Date().toISOString(),
): void {
  const path = getInstallDecisionsPath();
  mkdirSync(dirname(path), { recursive: true });
  const next = { ...loadInstallDecisions(), [serverId]: { decision, decidedAt } };
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/** Checks whether a value is a valid persisted decision. */
export function isInstallDecision(value: unknown): value is InstallDecision {
  return decodeLspSchema(DecisionSchema, value) !== undefined;
}
