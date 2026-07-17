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
    expect(context).toContain(
      'Root is the default user-facing agent. Start the first user-facing update: "I detect ',
    );
    expect(context).toContain("Only plan, plan-review, and define-goal print");
    expect(context).toContain("no other skill or style mode prints an activation heading");
    expect(context).toContain("before the first shell action, inspect callable and deferred tools");
    expect(context).toContain("Use it for every shell command");
    expect(context).toContain("Never fall back to PowerShell or cmd");
    expect(context).toContain("load caveman");
    expect(context).toContain("Default user-facing replies:");
    expect(context).toContain(
      "Root owns user interaction, intent, scope, architecture, product decisions, ambiguity resolution, integration, final judgment, and final verification.",
    );
    expect(context).toContain("Presume bounded independent work delegable");
    expect(context).not.toContain("Before substantial");
    expect(context).toContain("more than two root tool calls");
    expect(context).toContain("multiple sources or version/date verification");
    expect(context).toContain("dispatch plus review is concretely more expensive");
    expect(context).toContain("record one concise concrete reason internally");
    expect(context).toContain("do not require user-visible orchestration commentary");
    expect(context).toContain("Skills govern method, not routing");
    expect(context).toContain("at most two concurrently per wave");
    expect(context).toContain("Explorer uses GPT 5.6 Luna low");
    expect(context).toContain("Librarian uses GPT 5.6 Luna low");
    expect(context).toContain("Worker uses GPT 5.6 Terra high");
    expect(context).toContain("Packets have five concepts");
    expect(context).toContain("Do not duplicate specialist work");
    expect(context).toContain("spot-check only load-bearing claims");
    expect(context).toContain("Never repeat Explorer/Librarian searches for reassurance");
    expect(context).toContain("Never recurse, let specialists delegate");
    expect(context).toContain("overlapping write ownership");
    expect(context).toContain("Specialists stop when their bounded task is complete");
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
      "Never fall back to PowerShell or cmd",
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
