import type { DoctorResult } from "./doctor.ts";
import type { RunResult } from "./install.ts";

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

/** Checks whether terminal color output is supported. */
export function supportsColor(isTTY: boolean | undefined, noColor: string | undefined): boolean {
  return isTTY === true && noColor === undefined;
}

/** Renders help. */
export function renderHelp(version: string, color: boolean): string {
  const title = paint(color, `${BOLD}${CYAN}`, `HOLYCODEX ${version}`);
  const section = (text: string): string => paint(color, BOLD, text);
  const muted = (text: string): string => paint(color, DIM, text);
  return `${title}\n${muted("Lean Codex toolkit installer and doctor")}\n\n${section("USAGE")}\n  holycodex <command> [options]\n\n${section("COMMANDS")}\n  install                         Install or update HolyCodex\n  cleanup                         Remove HolyCodex-owned state\n  doctor                          Diagnose installation and runtime\n\n${section("OPTIONS")}\n  -h, --help                      Show help\n  -v, --version                   Show version\n  --no-tui                        Accepted; commands remain noninteractive\n  --codex-autonomous              Never ask; keep workspace sandbox\n  --no-codex-autonomous           Safe interactive defaults\n  --dangerous-codex-autonomous    Never ask; disable filesystem sandbox\n  --json                          Print machine-readable output\n`;
}

/** Renders error. */
export function renderError(message: string, color: boolean): string {
  const label = paint(color, `${BOLD}${RED}`, "✗ ERROR");
  const hint = paint(color, DIM, "Run holycodex --help for usage.");
  return `${label}  ${message}\n  ${hint}\n`;
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
  return `${title}\n  Changed: ${result.changed.length}\n  Backups: ${result.backups.length}\n`;
}

/** Renders notice. */
export function renderNotice(kind: "notice" | "warning", message: string, color: boolean): string {
  const label = kind === "warning" ? "WARNING" : "NOTICE";
  return `${paint(color, kind === "warning" ? RED : YELLOW, `! ${label}`)}  ${message}\n`;
}
