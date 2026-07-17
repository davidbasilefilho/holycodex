import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { contextEnv } from "../request-context.js";

const InstallDecisionSchema = z.enum(["declined", "allowed"]);
export type InstallDecision = z.infer<typeof InstallDecisionSchema>;

const InstallDecisionRecordSchema = z.strictObject({
  decision: InstallDecisionSchema,
  decidedAt: z.string().min(1),
});
export type InstallDecisionRecord = z.infer<typeof InstallDecisionRecordSchema>;

const InstallDecisionsSchema = z.record(z.string(), InstallDecisionRecordSchema);
type InstallDecisions = z.infer<typeof InstallDecisionsSchema>;

/** Gets install decisions path. */
export function getInstallDecisionsPath(): string {
  const override = contextEnv("LSP_TOOLS_MCP_INSTALL_DECISIONS");
  if (!override) return join(homedir(), ".codex", "lsp-install-decisions.json");
  return isAbsolute(override) ? override : join(homedir(), override);
}

/** Loads install decisions. */
export function loadInstallDecisions(): InstallDecisions {
  const path = getInstallDecisionsPath();
  if (!existsSync(path)) return {};
  try {
    return InstallDecisionsSchema.safeParse(JSON.parse(readFileSync(path, "utf8"))).data ?? {};
  } catch {
    return {};
  }
}

/** Loads install decision. */
export function loadInstallDecision(serverId: string): InstallDecisionRecord | undefined {
  return loadInstallDecisions()[serverId];
}

/** Records install decision. */
export function recordInstallDecision(
  serverId: string,
  decision: InstallDecision,
  decidedAt: string = new Date().toISOString(),
): void {
  const decisions = loadInstallDecisions();
  decisions[serverId] = { decision, decidedAt };
  writeInstallDecisions(decisions);
}

/** Checks whether install decision. */
export function isInstallDecision(value: unknown): value is InstallDecision {
  return InstallDecisionSchema.safeParse(value).success;
}

function writeInstallDecisions(decisions: InstallDecisions): void {
  const path = getInstallDecisionsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(decisions, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
}
