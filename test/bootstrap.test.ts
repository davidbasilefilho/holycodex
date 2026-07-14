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
    expect(context).toContain("on native Windows, before any shell call");
    expect(context).toContain("resolve `mcp__git_bash__run` from the full callable registry");
    expect(context).toContain("including deferred tools");
    expect(context).toContain("otherwise use the native shell directly");
    expect(context).toContain("load caveman");
    expect(context).toContain("Default user-facing replies:");
    expect(context).toContain(
      "Main agent owns intent, scope, architecture, decisions, integration, and final verification.",
    );
    expect(context).toContain("a skill alone is sufficient");
    expect(context).toContain("Delegate only a bounded, independent, unambiguous slice");
    expect(context).toContain("explorer=read-only exact repo facts");
    expect(context).toContain("librarian=read-only current external facts");
    expect(context).toContain("worker=isolated fixed-scope implementation");
    expect(context).toContain("Never delegate trivial or coupled work, architecture");
    expect(context).toContain("Every packet states exact question or outcome");
    expect(context).toContain("Treat returns as input");
    expect(context).toContain("never recurse or create agent organizations");
  });

  it("emits SessionStart context in the Codex command-hook envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-bootstrap-"));
    const output = JSON.parse(await readinessOutput(root)) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };

    expect(output.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(output.hookSpecificOutput?.additionalContext).toContain(
      "otherwise use the native shell directly",
    );
  });
});
