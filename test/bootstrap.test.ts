import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readinessContext, readinessOutput } from "../src/bootstrap";

describe("bootstrap readiness", () => {
  it("reports missing local runtimes and stays silent when ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-bootstrap-"));
    expect(await readinessContext(root)).toContain("git-bash.js");
    await mkdir(join(root, "runtime"));
    await Promise.all(
      ["git-bash.js", "lsp.js", "rules.js"].map((file) =>
        writeFile(join(root, "runtime", file), ""),
      ),
    );
    const context = await readinessContext(root);
    expect(context).toContain('Start first user-facing update: "I detect ');
    expect(context).toContain("Shell: git_bash MCP");
    expect(context).toContain("load caveman");
    expect(context).toContain("Primary owns decisions, integration, verification.");
    expect(context).toContain("Delegate only bounded independent work that saves cost/time");
    expect(context).toContain("explorer=repo facts");
    expect(context).toContain("librarian=current external facts");
    expect(context).toContain("worker=isolated implementation");
    expect(context).toContain("Never delegate responsibility, trivial, or tightly coupled work.");
    expect(context).toContain("Subagents cut cost, not form organization.");
    expect(context).toContain("Match reasoning effort to complexity.");
  });

  it("emits SessionStart context in the Codex command-hook envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-bootstrap-"));
    const output = JSON.parse(await readinessOutput(root)) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };

    expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput?.additionalContext).toContain("Shell: git_bash MCP");
  });
});
