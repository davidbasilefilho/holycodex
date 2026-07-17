import { describe, expect, it } from "vitest";
import {
  renderDoctor,
  renderHelp,
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
    expect(output).not.toContain("\u001B[");
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

  it("summarizes install results without leaking paths", () => {
    const output = renderRunResult(
      { action: "install", changed: ["secret/path"], backups: ["backup/path"] },
      false,
    );
    expect(output).toContain("Changed: 1");
    expect(output).toContain("Backups: 1");
    expect(output).not.toContain("secret/path");
  });
});
