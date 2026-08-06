import { describe, expect, it } from "vitest";

import {
  renderDoctor,
  renderHelp,
  renderInstallHelp,
  renderInstallProgress,
  renderNotice,
  renderRunResult,
  supportsColor,
} from "../packages/cli/src/presentation.ts";

describe("CLI presentation", () => {
  it("renders structured plain help without terminal escapes", () => {
    const output = renderHelp("0.6.0", false);
    expect(output).toContain("HolyCodex 0.6.0");
    expect(output).toContain("COMMANDS");
    expect(output).toContain("--dangerous-codex-autonomous");
    expect(output).toContain("--max-subagents <count>");
    expect(output).toContain("--fast");
    expect(output).toContain("--no-fast");
    expect(output).toContain("install --verbose");
    expect(output).not.toContain("\u001B[");
  });

  it("renders reactive concise progress and verbose details", () => {
    const event = {
      step: "computer-use",
      label: "Installing Computer Use",
      status: "complete",
      detail: "already-installed",
    } as const;
    expect(renderInstallProgress(event, false, false, false)).toBe("  ✓ Installing Computer Use\n");
    expect(renderInstallProgress(event, false, false, true)).toContain("already-installed");
    expect(renderInstallProgress({ ...event, status: "running" }, false, true, false)).toBe(
      "\r● Installing Computer Use",
    );
  });

  it("renders Computer Use installation status", () => {
    const output = renderRunResult(
      {
        action: "install",
        changed: [],
        backups: [],
        computerUse: { status: "installed" },
      },
      false,
    );
    expect(output).toContain("Installed official Computer Use plugin.");
  });

  it("renders Build Web Apps installation status", () => {
    const output = renderRunResult(
      {
        action: "install",
        changed: [],
        backups: [],
        buildWebApps: { status: "installed" },
      },
      false,
    );
    expect(output).toContain("Installed official Build Web Apps plugin.");
  });

  it("renders install plan help and examples", () => {
    const output = renderInstallHelp("0.7.1", false);
    expect(output).toContain("holycodex install [options]");
    expect(output).toContain("go, plus-low, plus, plus-high, pro-5x, or pro-20x");
    expect(output).toContain("Default: plus-low");
    expect(output).toContain("increasing expected model usage and capability");
    expect(output).toContain("bunx holycodex install --plan pro-20x");
    expect(output).toContain("bunx holycodex install --plan plus-low");
    expect(output).toContain("bunx holycodex install --plan plus-high");
    expect(output).toContain("--json");
    expect(output).toContain("--no-tui");
    expect(output).toContain("--codex-autonomous");
    expect(output).toContain("--no-codex-autonomous");
    expect(output).toContain("--dangerous-codex-autonomous");
    expect(output).toContain("--fast");
    expect(output).toContain("--no-fast");
    expect(output).toContain("-v, --verbose");
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

  it.each([
    [{ status: "installed" }, "Installed official Codex Security plugin."],
    [{ status: "enabled" }, "Enabled existing official Codex Security plugin."],
    [
      { status: "already-installed" },
      "Official Codex Security plugin is already installed and enabled.",
    ],
    [{ status: "skipped", reason: "codex-unavailable" }, "no usable Codex launcher was found."],
    [{ status: "skipped", reason: "unauthenticated" }, "Codex authentication is required."],
    [
      { status: "skipped", reason: "marketplace-unavailable" },
      "the official plugin marketplace was unavailable.",
    ],
    [
      { status: "skipped", reason: "plugin-not-offered" },
      "the configured marketplace does not offer the official plugin.",
    ],
    [
      { status: "skipped", reason: "all-launchers-lacked-plugin" },
      "no usable Codex launcher offered the official plugin.",
    ],
    [
      { status: "skipped", reason: "plugin-unavailable" },
      "the plugin was unavailable from every usable Codex launcher.",
    ],
    [
      { status: "skipped", reason: "verification-failed" },
      "Codex did not confirm the plugin was installed and enabled.",
    ],
    [
      { status: "skipped", reason: "installation-rejected" },
      "the account or workspace policy rejected installation.",
    ],
    [{ status: "skipped", reason: "timeout" }, "all usable Codex launchers timed out."],
    [
      { status: "skipped", reason: "invalid-response" },
      "Codex returned an unsupported or malformed response.",
    ],
    [
      { status: "skipped", reason: "unsupported" },
      "the available Codex launchers do not support plugin installation.",
    ],
    [
      { status: "skipped", reason: "download-failed" },
      "the latest Codex package could not be downloaded.",
    ],
  ] as const)("renders Codex Security result %j", (codexSecurity, message) => {
    const output = renderRunResult(
      { action: "install", changed: [], backups: [], codexSecurity },
      false,
    );
    expect(output).toContain(message);
    expect(JSON.parse(JSON.stringify({ codexSecurity }))).toEqual({ codexSecurity });
  });
});
