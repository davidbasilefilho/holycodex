import { describe, expect, it } from "vitest";

import {
  renderDoctor,
  renderHelp,
  renderInstallHelp,
  renderNotice,
  renderRunResult,
  supportsColor,
} from "../packages/cli/src/presentation.ts";

describe("CLI presentation", () => {
  it("renders structured plain help without terminal escapes", () => {
    const output = renderHelp("0.6.0", false);
    expect(output).toContain("HOLYCODEX 0.6.0");
    expect(output).toContain("COMMANDS");
    expect(output).toContain("--dangerous-codex-autonomous");
    expect(output).toContain("--max-subagents <count>");
    expect(output).not.toContain("\u001B[");
  });

  it("renders install plan help and examples", () => {
    const output = renderInstallHelp("0.7.1", false);
    expect(output).toContain("holycodex install [options]");
    expect(output).toContain("go, plus-low, plus, plus-high, pro-5x, or pro-20x");
    expect(output).toContain("Default: plus");
    expect(output).toContain("increasing expected model usage and capability");
    expect(output).toContain("bunx holycodex install --plan pro-20x");
    expect(output).toContain("bunx holycodex install --plan plus-low");
    expect(output).toContain("bunx holycodex install --plan plus-high");
    expect(output).toContain("--json");
    expect(output).toContain("--no-tui");
    expect(output).toContain("--codex-autonomous");
    expect(output).toContain("--no-codex-autonomous");
    expect(output).toContain("--dangerous-codex-autonomous");
  });

  it("uses color only for a TTY without NO_COLOR", () => {
    expect(supportsColor(true, undefined)).toBe(true);
    expect(supportsColor(false, undefined)).toBe(false);
    expect(supportsColor(true, "1")).toBe(false);
    expect(renderNotice("warning", "unsafe", true)).toContain("\u001B[31m");
  });

  it("renders aligned doctor checks and fixes", () => {
    const output = renderDoctor(
      {
        healthy: false,
        autonomy: "unknown",
        checks: [
          { id: "package", status: "ok", code: "ready", detail: "Ready." },
          {
            id: "context7",
            status: "warning",
            code: "missing",
            detail: "Unavailable.",
            fix: "Install Bun.",
          },
        ],
      },
      false,
    );
    expect(output).toContain("OK      package");
    expect(output).toContain("WARNING context7");
    expect(output).toContain("Fix: Install Bun.");
  });

  it("renders action-specific results without counts or paths", () => {
    const install = renderRunResult(
      { action: "install", changed: ["secret/path"], backups: ["backup/path"] },
      false,
    );
    const cleanup = renderRunResult(
      { action: "cleanup", changed: ["secret/path"], backups: [] },
      false,
    );
    const unchangedInstall = renderRunResult(
      { action: "install", changed: [], backups: [] },
      false,
    );
    const unchanged = renderRunResult({ action: "cleanup", changed: [], backups: [] }, false);
    expect(install).toContain("Updated HolyCodex configuration, plugin files, and agent profiles.");
    expect(install).toContain("Existing HolyCodex files were backed up before replacement.");
    expect(cleanup).toContain("Removed HolyCodex configuration, plugin files, and agent profiles.");
    expect(unchangedInstall).toContain("No HolyCodex-managed files needed changes.");
    expect(unchanged).toContain("No HolyCodex-managed files needed removal.");
    expect(`${install}${cleanup}${unchangedInstall}${unchanged}`).not.toMatch(
      /(?:Changed|Backups):|secret\/path/,
    );
  });
});
