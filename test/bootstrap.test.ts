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
    expect(context).toContain("Before updates, classify intent/load required skills");
    expect(context).toContain(
      "Do not narrate required skill loading, tool selection, instruction compliance, or routine policy checks; perform them silently.",
    );
    expect(context).toContain("never print provisionally");
    expect(
      context.match(/I detect \[fix\/implementation\/investigation\/question\] intent/g),
    ).toHaveLength(1);
    expect(context).toContain("`plan`/`plan-review` instead own their exact heading/intent");
    expect(context).toContain("no other mode prints a heading");
    expect(context).toContain("before the first shell action, inspect callable and deferred tools");
    expect(context).toContain("Use it for every shell command");
    expect(context).toContain("Never fall back to PowerShell or cmd");
    expect(context).toContain("`caveman`");
    expect(context).toMatch(/Root owns interaction, intent, scope, architecture/);
    expect(context).toContain("Default to delegation: delegate the first clear unit");
    expect(context).toContain("No delegation quota");
    expect(context).toContain("never assign overlapping writes");
    expect(context).toMatch(/Work locally only if atomic, coupled, architecturally unresolved/);
    expect(context).toContain("keep the reason internal unless it materially affects the result");
    expect(context).toContain("Skills govern method, not routing");
    expect(context).toContain("Use at most two lanes per wave");
    expect(context).toContain('fork_turns="none"');
    expect(context).toContain("fork_context=false");
    expect(context).not.toMatch(/(?:Explorer|Librarian|Worker) (?:uses|runs) GPT 5\.6/);
    expect(context).toMatch(/Packets: outcome\/question, scope, fixed constraints\/decisions/);
    expect(context).toContain("spot-check load-bearing claims");
    expect(context).toContain("Specialists never delegate/broaden");
    expect(context).toContain("overlap writes");
    expect(context).toContain("specialists stop at packet completion");
    expect(context).toMatch(
      /delegate facts, ask material decisions, state\/use safe reversible defaults/,
    );
    expect(context).toContain("exact monetary/token cost");
    expect(context).toContain("Explorer is mandatory before a second separable repo search");
    expect(context).toContain("Librarian before a second external source");
    expect(context).toContain("Worker for fixed isolated work beyond one file");
    expect(context).toContain("request_user_input");
    expect(context).toContain("one to three exclusive choices");
    expect(context).toContain("no timeout");
    expect(context).toContain("Root itself defaults to browser control for browser UI");
    expect(context).toContain("and to computer use for non-browser desktop/native Windows UI");
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
