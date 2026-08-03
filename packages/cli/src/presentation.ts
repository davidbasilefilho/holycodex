import { z } from "zod";

import { DEFAULT_PLAN, PLAN_NAMES } from "./catalog.ts";
import type { CodexSecuritySkipReason } from "./codex-security.ts";
import type { DoctorResult } from "./doctor.ts";
import type { InstallProgressEvent, RunResult } from "./install.ts";

const PLAN_HELP = `${PLAN_NAMES.slice(0, -1).join(", ")}, or ${PLAN_NAMES.at(-1)}`;

const RESET = "\u001B[0m";
const BOLD = "\u001B[1m";
const CYAN = "\u001B[36m";
const GREEN = "\u001B[32m";
const YELLOW = "\u001B[33m";
const RED = "\u001B[31m";
const DIM = "\u001B[2m";

function paint(enabled: boolean, code: string, text: string): string {
  return enabled ? `${code}${text}${RESET}` : text;
}

/** Formats an unknown CLI failure without exposing validation internals. */
export function formatCliError(error: unknown): string {
  if (!(error instanceof z.ZodError)) return error instanceof Error ? error.message : String(error);
  return error.issues
    .map((issue) => `${issue.path.length === 0 ? "input" : issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/** Checks whether terminal color output is supported. */
export function supportsColor(isTTY: boolean | undefined, noColor: string | undefined): boolean {
  return isTTY === true && noColor === undefined;
}

/** Renders help. */
export function renderHelp(version: string, color: boolean): string {
  const title = paint(color, `${BOLD}${CYAN}`, `HolyCodex ${version}`);
  const section = (text: string): string => paint(color, BOLD, text);
  const muted = (text: string): string => paint(color, DIM, text);
  return `${title}\n${muted("Lean Codex toolkit installer and doctor")}\n\n${section("USAGE")}\n  holycodex <command> [options]\n\n${section("COMMANDS")}\n  install                         Install or update HolyCodex\n  cleanup                         Remove HolyCodex-owned state\n  doctor                          Diagnose installation and runtime\n\n${section("OPTIONS")}\n  --plan <plan>                   Model routing plan for install: ${PLAN_HELP}\n                                   Default: ${DEFAULT_PLAN}\n  --max-subagents <count>          Override concurrent direct subagents for install\n  --fast                          Use Fast for generated subagents only\n  --fast-all                      Use Fast for Root and generated subagents\n  --no-fast                       Use Standard for Root and generated subagents\n  -h, --help                      Show help\n  -v, --version                   Show version\n  --no-tui                        Accepted; commands remain noninteractive\n  --codex-autonomous              Never ask; keep workspace sandbox\n  --no-codex-autonomous           Safe interactive defaults\n  --dangerous-codex-autonomous    Never ask; disable filesystem sandbox\n  install --verbose              Show detailed install steps
  --json                          Print machine-readable output\n`;
}

/** Renders install-specific model plan and option help. */
export function renderInstallHelp(version: string, color: boolean): string {
  const title = paint(color, `${BOLD}${CYAN}`, `HolyCodex ${version}`);
  const section = (text: string): string => paint(color, BOLD, text);
  return `${title}\n\n${section("Usage:")}\n  holycodex install [options]\n\n${section("Options:")}\n  --plan <plan>                   Model routing plan: ${PLAN_HELP}\n                                   Default: ${DEFAULT_PLAN}\n  --max-subagents <count>          Override concurrent direct subagents\n  --fast                          Use Fast for generated subagents only\n  --fast-all                      Use Fast for Root and generated subagents\n  --no-fast                       Use Standard for Root and generated subagents\n  -v, --verbose                   Show detailed install steps
  --json                          Print machine-readable output\n  --no-tui                        Accepted; install remains noninteractive\n  --codex-autonomous              Never ask; keep workspace sandbox\n  --no-codex-autonomous           Safe interactive defaults\n  --dangerous-codex-autonomous    Never ask; disable filesystem sandbox\n  -h, --help                      Show help\n\nPlans provide increasing expected model usage and capability. Fast flags are mutually exclusive.\n\n${section("Examples:")}\n  bunx holycodex install\n  bunx holycodex install --plan go\n  bunx holycodex install --plan plus-low --fast\n  bunx holycodex install --plan plus-high\n  bunx holycodex install --plan pro-5x --fast-all\n  bunx holycodex install --plan pro-20x --no-fast\n`;
}

/** Renders error. */
export function renderError(message: string, color: boolean): string {
  const label = paint(color, `${BOLD}${RED}`, "✗ ERROR");
  const hint = paint(color, DIM, "Run holycodex --help for usage.");
  const clearProgress = color ? "\r\u001B[2K" : "";
  return `${clearProgress}${label}  ${message}\n  ${hint}\n`;
}

/** Renders doctor. */
export function renderDoctor(result: DoctorResult, color: boolean): string {
  const headline = result.healthy
    ? paint(color, GREEN, "✓ HolyCodex doctor: healthy")
    : paint(color, RED, "✗ HolyCodex doctor: issues found");
  const checks = result.checks.map((item) => {
    const label = item.status.toUpperCase().padEnd(7);
    const code = item.status === "ok" ? GREEN : item.status === "warning" ? YELLOW : RED;
    const line = `  ${paint(color, code, label)} ${item.id}  ${item.detail}`;
    return item.fix === undefined
      ? line
      : `${line}\n           ${paint(color, DIM, `Fix: ${item.fix}`)}`;
  });
  return `${headline}\n${checks.join("\n")}\n`;
}

/** Renders run result. */
export function renderRunResult(result: RunResult, color: boolean): string {
  const title = paint(color, GREEN, `✓ HolyCodex ${result.action} complete`);
  const action = result.action === "install" ? "Updated" : "Removed";
  const empty = result.action === "install" ? "changes" : "removal";
  const backup =
    result.backups.length === 0
      ? ""
      : `\n  Existing HolyCodex files were backed up before ${result.action === "install" ? "replacement" : "cleanup"}.`;
  const detail =
    result.changed.length === 0
      ? `No HolyCodex-managed files needed ${empty}.`
      : `${action} HolyCodex configuration, plugin files, and agent profiles.`;
  const officialPlugins = renderOfficialPlugins(result);
  return `${title}\n  ${detail}${backup}${officialPlugins}\n`;
}

function renderOfficialPlugins(result: RunResult): string {
  return [
    renderOfficialPlugin("Codex Security", result.codexSecurity),
    renderOfficialPlugin("Computer Use", result.computerUse),
  ].join("");
}

function renderOfficialPlugin(name: string, plugin: RunResult["codexSecurity"]): string {
  if (plugin === undefined) return "";
  if (plugin.status === "installed") return `\n  Installed official ${name} plugin.`;
  if (plugin.status === "enabled") return `\n  Enabled existing official ${name} plugin.`;
  if (plugin.status === "already-installed")
    return `\n  Official ${name} plugin is already installed and enabled.`;
  return `\n  Skipped official ${name} plugin: ${CODEX_SECURITY_SKIP_MESSAGES[plugin.reason]}`;
}

const CODEX_SECURITY_SKIP_MESSAGES: Record<CodexSecuritySkipReason, string> = {
  "codex-unavailable": "no usable Codex launcher was found.",
  unauthenticated: "Codex authentication is required.",
  "marketplace-unavailable": "the official plugin marketplace was unavailable.",
  "plugin-not-offered": "the configured marketplace does not offer the official plugin.",
  "all-launchers-lacked-plugin": "no usable Codex launcher offered the official plugin.",
  "plugin-unavailable": "the plugin was unavailable from every usable Codex launcher.",
  "verification-failed": "Codex did not confirm the plugin was installed and enabled.",
  "installation-rejected": "the account or workspace policy rejected installation.",
  timeout: "all usable Codex launchers timed out.",
  "invalid-response": "Codex returned an unsupported or malformed response.",
  unsupported: "the available Codex launchers do not support plugin installation.",
  "download-failed": "the latest Codex package could not be downloaded.",
};

/** Renders one concise installation progress transition. */
export function renderInstallProgress(
  event: InstallProgressEvent,
  color: boolean,
  isTTY: boolean,
  verbose: boolean,
): string {
  const detail =
    verbose && event.detail !== undefined ? `  ${paint(color, DIM, event.detail)}` : "";
  if (event.status === "running") return isTTY ? `\r${paint(color, CYAN, "●")} ${event.label}` : "";
  const line = `${paint(color, GREEN, "✓")} ${event.label}${detail}`;
  return isTTY ? `\r\u001B[2K${line}\n` : `  ${line}\n`;
}

/** Renders notice. */
export function renderNotice(kind: "notice" | "warning", message: string, color: boolean): string {
  const label = kind === "warning" ? "WARNING" : "NOTICE";
  return `${paint(color, kind === "warning" ? RED : YELLOW, `! ${label}`)}  ${message}\n`;
}
