// SPDX-License-Identifier: Apache-2.0

import * as Schema from "effect/Schema";
import { freezeDeep } from "./common.ts";

export const ApprovalPolicyActionSchema = Schema.Literal(
  "workflow.create",
  "workflow.run",
  "workflow.resume",
  "local.repository.edit",
  "local.repository.check",
  "local.repository.lint",
  "local.repository.format",
  "local.repository.commit",
  "external.read",
  "specialist.dispatch",
  "vcs.server.mutation",
  "vcs.server.ci-trigger",
  "unknown.effect",
);
export type ApprovalPolicyAction = typeof ApprovalPolicyActionSchema.Type;

export const ApprovalPolicyEntrySchema = Schema.Struct({
  identifier: ApprovalPolicyActionSchema,
  label: Schema.String,
  requiresRootApproval: Schema.Boolean,
});
export type ApprovalPolicyEntry = typeof ApprovalPolicyEntrySchema.Type;

function approvalPolicyEntrySchema<const Identifier extends ApprovalPolicyAction>(
  identifier: Identifier,
) {
  return Schema.Struct({
    identifier: Schema.Literal(identifier),
    label: Schema.String,
    requiresRootApproval: Schema.Boolean,
  });
}

export const ApprovalPolicySchema = Schema.Struct({
  workflowCreate: approvalPolicyEntrySchema("workflow.create"),
  workflowRun: approvalPolicyEntrySchema("workflow.run"),
  workflowResume: approvalPolicyEntrySchema("workflow.resume"),
  localRepositoryEdit: approvalPolicyEntrySchema("local.repository.edit"),
  localRepositoryCheck: approvalPolicyEntrySchema("local.repository.check"),
  localRepositoryLint: approvalPolicyEntrySchema("local.repository.lint"),
  localRepositoryFormat: approvalPolicyEntrySchema("local.repository.format"),
  localRepositoryCommit: approvalPolicyEntrySchema("local.repository.commit"),
  externalRead: approvalPolicyEntrySchema("external.read"),
  specialistDispatch: approvalPolicyEntrySchema("specialist.dispatch"),
  versionControlServerMutation: approvalPolicyEntrySchema("vcs.server.mutation"),
  versionControlServerCiTrigger: approvalPolicyEntrySchema("vcs.server.ci-trigger"),
  unknownEffect: approvalPolicyEntrySchema("unknown.effect"),
});
export type ApprovalPolicy = typeof ApprovalPolicySchema.Type;

export const APPROVAL_POLICY = {
  workflowCreate: {
    identifier: "workflow.create",
    label: "workflow create",
    requiresRootApproval: false,
  },
  workflowRun: {
    identifier: "workflow.run",
    label: "workflow run",
    requiresRootApproval: false,
  },
  workflowResume: {
    identifier: "workflow.resume",
    label: "workflow resume",
    requiresRootApproval: false,
  },
  localRepositoryEdit: {
    identifier: "local.repository.edit",
    label: "local repository edit",
    requiresRootApproval: false,
  },
  localRepositoryCheck: {
    identifier: "local.repository.check",
    label: "local repository check",
    requiresRootApproval: false,
  },
  localRepositoryLint: {
    identifier: "local.repository.lint",
    label: "local repository lint",
    requiresRootApproval: false,
  },
  localRepositoryFormat: {
    identifier: "local.repository.format",
    label: "local repository format",
    requiresRootApproval: false,
  },
  localRepositoryCommit: {
    identifier: "local.repository.commit",
    label: "local repository commit",
    requiresRootApproval: false,
  },
  externalRead: {
    identifier: "external.read",
    label: "external read",
    requiresRootApproval: false,
  },
  specialistDispatch: {
    identifier: "specialist.dispatch",
    label: "specialist dispatch",
    requiresRootApproval: false,
  },
  versionControlServerMutation: {
    identifier: "vcs.server.mutation",
    label: "version-control-server mutation",
    requiresRootApproval: true,
  },
  versionControlServerCiTrigger: {
    identifier: "vcs.server.ci-trigger",
    label: "version-control-server CI triggering",
    requiresRootApproval: true,
  },
  unknownEffect: {
    identifier: "unknown.effect",
    label: "unclassified effect",
    requiresRootApproval: true,
  },
} as const satisfies ApprovalPolicy;

freezeDeep(APPROVAL_POLICY);

export const ApprovalModeSchema = Schema.Literal("never", "root");
export type ApprovalMode = typeof ApprovalModeSchema.Type;

const policyEntries = Object.values(APPROVAL_POLICY);

/** Returns the immutable approval entry for a known action identifier. */
export function lookupApprovalPolicy(action: ApprovalPolicyAction): ApprovalPolicyEntry {
  const entry = policyEntries.find((candidate) => candidate.identifier === action);
  if (entry === undefined) {
    throw new Error("Unknown approval policy action.");
  }
  return entry;
}

/** Maps a policy action to the workflow host approval mode. */
export function approvalModeFor(action: ApprovalPolicyAction): ApprovalMode {
  return lookupApprovalPolicy(action).requiresRootApproval ? "root" : "never";
}

function formatActionList(entries: readonly ApprovalPolicyEntry[]): string {
  const labels = entries.map((entry) => entry.label);
  const last = labels.at(-1);
  if (last === undefined) {
    return "";
  }
  if (labels.length === 1) {
    return last;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${last}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}

const noRootApprovalEntries = policyEntries.filter((entry) => !entry.requiresRootApproval);
const rootApprovalEntries = policyEntries.filter((entry) => entry.requiresRootApproval);

export const APPROVAL_POLICY_GUIDANCE = Object.freeze({
  noRootApproval: `${capitalize(formatActionList(noRootApprovalEntries))} actions do not require Root approval.`,
  rootApproval: `${capitalize(formatActionList(rootApprovalEntries))} require Root approval.`,
} as const);
