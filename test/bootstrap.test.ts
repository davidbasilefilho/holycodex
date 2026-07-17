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
    expect(context).toContain("Mode activation takes precedence");
    expect(context).toContain("before the first shell action, inspect callable and deferred tools");
    expect(context).toContain("Use it for every shell command");
    expect(context).toContain("Never fall back to PowerShell or cmd");
    expect(context).toContain("load caveman");
    expect(context).toContain("Default user-facing replies:");
    expect(context).toContain(
      "Root owns intent, scope, architecture, decisions, user clarification, reconciliation, integration, final judgment, and final verification.",
    );
    expect(context).toContain("Skills govern method; they do not replace cost-aware delegation");
    expect(context).toContain("one wave by default");
    expect(context).toContain("at most two specialists concurrently");
    expect(context).toContain("Explorer handles exact read-only repository facts");
    expect(context).toContain("Librarian handles current external facts from primary sources");
    expect(context).toContain("Worker handles isolated fixed-scope implementation");
    expect(context).toContain("Every packet contains exact outcome or question");
    expect(context).toContain("Never duplicate delegated work");
    expect(context).toContain("Treat specialist returns as input");
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
