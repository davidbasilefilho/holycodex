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
    expect(context).toContain("Delegate long, context-heavy, separable, or easier work");
    expect(context).toContain(
      "Keep work local only when atomic, coupled, architecturally unresolved",
    );
    expect(context).toContain("record one concise concrete reason internally");
    expect(context).toContain("do not require user-visible orchestration commentary");
    expect(context).toContain("Skills govern method, not routing");
    expect(context).toContain("Run at most two lanes per wave");
    expect(context).toContain("fork_context=false");
    expect(context).not.toMatch(/(?:Explorer|Librarian|Worker) (?:uses|runs) GPT 5\.6/);
    expect(context).toContain("Packets have five concepts");
    expect(context).toContain("Do not duplicate specialist work");
    expect(context).toContain("spot-check only load-bearing claims");
    expect(context).toContain("Never repeat Explorer/Librarian searches for reassurance");
    expect(context).toContain("Never recurse; specialists never delegate");
    expect(context).toContain("overlapping write ownership");
    expect(context).toContain("Specialists stop when their bounded task is complete");
    expect(context).toContain("delegate discoverable facts");
    expect(context).toContain("ask the user for a material decision");
    expect(context).toContain("state and proceed with a safe reversible default");
    expect(context).toContain("exact monetary or token cost");
    expect(context).toContain(
      "Explorer is mandatory before a second separable repository read/search",
    );
    expect(context).toContain("Librarian is mandatory before a second external source");
    expect(context).toContain(
      "Worker is mandatory for fixed isolated implementation beyond one file",
    );
    expect(context).toContain("request_user_input");
    expect(context).toContain("one to three current blockers");
    expect(context).toContain("no timeout");
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
