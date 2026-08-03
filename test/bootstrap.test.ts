import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readinessContext, readinessOutput } from "../packages/cli/src/bootstrap";

describe("bootstrap readiness", () => {
  it("reports missing local runtimes and stays silent when ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-bootstrap-"));
    const ready = { found: true, path: "bash.exe", source: "env", checkedPaths: [] } as const;
    expect(await readinessContext(root, "win32", ready)).toContain("git-bash.js");
    await mkdir(join(root, "runtime"));
    await Promise.all(
      ["git-bash.js", "lsp.js", "rules.js"].map((file) =>
        writeFile(join(root, "runtime", file), ""),
      ),
    );
    const context = await readinessContext(root, "win32", ready);
    expect(context).toContain("Before updates, classify intent and load required skills");
    expect(context).toContain(
      "Omit filler, hedging, repetition, decoration, self-reference, style announcements and tool narration.",
    );
    expect(context).toContain("never print provisionally");
    expect(
      context.match(/I detect \[fix\/implementation\/investigation\/question\] intent/g),
    ).toHaveLength(1);
    expect(context).toContain(
      "`plan` and `plan-review` instead own their exact heading and intent",
    );
    expect(context).toContain("no other mode prints a heading");
    expect(context).not.toContain("mcp__git_bash__run");
    expect(context).toContain("run every shell command through the bundled Git Bash launcher");
    expect(context).toContain("Never execute task commands through PowerShell or cmd");
    expect(context).not.toContain("`caveman`");
    expect(context).toMatch(/Root owns interaction, intent, scope, architecture/);
    expect(context).toContain("Delegate only useful bounded work");
    expect(context).toContain("never overlap writes");
    expect(context).toContain("Skills govern method, not routing");
    expect(context).toContain("Use at most two lanes per wave");
    expect(context).not.toMatch(/(?:Explorer|Librarian|Worker) (?:uses|runs) GPT 5\.6/);
    expect(context).toContain(
      "Specialists never delegate, broaden, review, or make final judgments",
    );
    expect(context).toContain("delegate facts, ask material decisions");
    expect(context).toContain("Explorer is mandatory before a second separable repository search");
    expect(context).toContain("Librarian before a second external source");
    expect(context).toContain("Worker for fixed isolated substantive implementation");
    expect(context).toContain("request_user_input");
    expect(context).toContain("Root controls browser and native desktop UI itself");
    expect(context).toContain("Never delegate browser or computer control");
    expect(context).toContain(
      "Use these capabilities instead of manual-click instructions, shell-as-GUI",
    );
  });

  it("emits SessionStart context in the Codex command-hook envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-bootstrap-"));
    const output = JSON.parse(
      await readinessOutput(root, "win32", {
        found: true,
        path: "bash.exe",
        source: "env",
        checkedPaths: [],
      }),
    ) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };

    expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput?.additionalContext).toContain(
      "Never execute task commands through PowerShell or cmd",
    );
  });

  it("blocks native Windows readiness when Git Bash is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-bootstrap-"));
    await mkdir(join(root, "runtime"));
    await Promise.all(
      ["git-bash.js", "lsp.js", "rules.js"].map((file) =>
        writeFile(join(root, "runtime", file), ""),
      ),
    );
    const context = await readinessContext(root, "win32", {
      found: false,
      checkedPaths: [],
      installHint: "Git Bash required. Install Git for Windows.",
    });
    expect(context).toContain("Git Bash required");
  });

  it("does not require or inject Git Bash off Windows", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-bootstrap-linux-"));
    await mkdir(join(root, "runtime"));
    await Promise.all(
      ["lsp.js", "rules.js"].map((file) => writeFile(join(root, "runtime", file), "")),
    );
    const context = await readinessContext(root, "linux", {
      found: false,
      checkedPaths: [],
      installHint: "irrelevant",
    });
    expect(context).not.toContain("mcp__git_bash__run");
    expect(context).not.toContain("missing runtime/git-bash.js");
  });
});
