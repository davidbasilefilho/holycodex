import { Buffer } from "node:buffer";

import { rootTomlString } from "./toml.ts";

export type AutonomyMode = "default" | "autonomous" | "dangerous";

export type RequestedAutonomy =
  | { readonly requested: false }
  | { readonly requested: true; readonly mode: AutonomyMode };

export type RawPermissionSelection = {
  readonly defaultPermissions?: string;
  readonly approvalPolicy?: string;
  readonly approvalsReviewer?: string;
  readonly sandboxMode?: string;
};

export const PERMISSION_KEYS = [
  "default_permissions",
  "approval_policy",
  "approvals_reviewer",
  "sandbox_mode",
] as const;

const AUTONOMY_PREFIX = "# holycodex autonomy: ";
const ORIGINAL_PERMISSION_PREFIX = "# holycodex original permissions: ";

/** Normalizes legacy string callers while preserving an omitted request. */
export function normalizeRequestedAutonomy(
  value: RequestedAutonomy | AutonomyMode | undefined,
): RequestedAutonomy {
  if (value === undefined) return { requested: false };
  if (typeof value === "string") return { requested: true, mode: value };
  return value;
}

/** Reads the raw root permission selection without filling missing values. */
export function readRawPermissionSelection(input: string): RawPermissionSelection {
  const defaultPermissions = rootTomlString(input, "default_permissions");
  const approvalPolicy = rootTomlString(input, "approval_policy");
  const approvalsReviewer = rootTomlString(input, "approvals_reviewer");
  const sandboxMode = rootTomlString(input, "sandbox_mode");
  return {
    ...(defaultPermissions === undefined ? {} : { defaultPermissions }),
    ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
    ...(approvalsReviewer === undefined ? {} : { approvalsReviewer }),
    ...(sandboxMode === undefined ? {} : { sandboxMode }),
  };
}

/** Returns root assignment lines for permission keys in source order. */
export function readPermissionLines(input: string): readonly string[] {
  const firstTable = input.search(/^\s*\[/m);
  const root = firstTable < 0 ? input : input.slice(0, firstTable);
  const keys = new Set<string>(PERMISSION_KEYS);
  return root.split(/\r?\n/).filter((line) => {
    const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    return key !== undefined && keys.has(key);
  });
}

/** Removes all root permission assignment lines while preserving other text. */
export function removePermissionLines(input: string): string {
  const firstTable = input.search(/^\s*\[/m);
  const root = firstTable < 0 ? input : input.slice(0, firstTable);
  const tables = firstTable < 0 ? "" : input.slice(firstTable);
  const keys = PERMISSION_KEYS.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const removed = root
    .split(/\r?\n/)
    .filter((line) => !new RegExp(`^\\s*(?:${keys.join("|")})\\s*=`).test(line))
    .join("\n")
    .trim();
  return `${removed}${tables ? `\n${tables.trimStart()}` : ""}`.trim();
}

/** Returns the exact tuple represented by an explicit autonomy mode. */
export function permissionSelectionForMode(mode: AutonomyMode): RawPermissionSelection {
  if (mode === "default")
    return {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxMode: "workspace-write",
    };
  if (mode === "autonomous") return { approvalPolicy: "never", sandboxMode: "workspace-write" };
  return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
}

/** Identifies generated tuples from current and historical installers. */
export function permissionSelectionMatchesMode(
  selection: RawPermissionSelection,
  mode: AutonomyMode,
): boolean {
  if (permissionSelectionsEqual(selection, permissionSelectionForMode(mode))) return true;
  return (
    mode === "default" &&
    permissionSelectionsEqual(selection, {
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
    })
  );
}

/** Compares all raw permission fields, including intentional omissions. */
export function permissionSelectionsEqual(
  left: RawPermissionSelection,
  right: RawPermissionSelection,
): boolean {
  return PERMISSION_KEYS.every((key) => {
    const field = permissionField(key);
    return left[field] === right[field];
  });
}

/** Identifies a historical generated tuple, if one is exact. */
export function inferAutonomyMode(selection: RawPermissionSelection): AutonomyMode | "custom" {
  for (const mode of ["default", "autonomous", "dangerous"] as const)
    if (permissionSelectionMatchesMode(selection, mode)) return mode;
  return "custom";
}

/** Reads deterministic autonomy metadata from a managed block. */
export function readAutonomyMetadata(input: string): AutonomyMode | "custom" | undefined {
  const value = new RegExp(`^${escapeRegExp(AUTONOMY_PREFIX)}(.+)$`, "m").exec(input)?.[1]?.trim();
  if (value === "default" || value === "autonomous" || value === "dangerous" || value === "custom")
    return value;
  return undefined;
}

/** Encodes durable original root permission assignment provenance. */
export function originalPermissionMetadata(lines: readonly string[]): string {
  const encoded =
    lines.length === 0 ? "-" : Buffer.from(lines.join("\n"), "utf8").toString("base64");
  return `${ORIGINAL_PERMISSION_PREFIX}${encoded}\n`;
}

/** Reads durable original root permission assignment provenance. */
export function readOriginalPermissionMetadata(input: string): readonly string[] | undefined {
  const encoded = new RegExp(
    `^${escapeRegExp(ORIGINAL_PERMISSION_PREFIX)}([A-Za-z0-9+/=_-]+)$`,
    "m",
  ).exec(input)?.[1];
  if (encoded === undefined) return undefined;
  if (encoded === "-") return [];
  return Buffer.from(encoded, "base64").toString("utf8").split(/\r?\n/).filter(Boolean);
}

/** Returns a generated tuple for an explicit request or preserves a live omitted selection. */
export function selectPermissionSelection(
  live: RawPermissionSelection,
  request: RequestedAutonomy,
): RawPermissionSelection {
  if (request.requested) return permissionSelectionForMode(request.mode);
  if (Object.keys(live).length > 0) return live;
  return permissionSelectionForMode("default");
}

export const AUTONOMY_METADATA_PREFIX = AUTONOMY_PREFIX;

function permissionField(key: (typeof PERMISSION_KEYS)[number]): keyof RawPermissionSelection {
  if (key === "default_permissions") return "defaultPermissions";
  if (key === "approval_policy") return "approvalPolicy";
  if (key === "approvals_reviewer") return "approvalsReviewer";
  return "sandboxMode";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
