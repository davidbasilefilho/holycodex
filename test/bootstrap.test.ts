import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readinessContext } from "../src/bootstrap";

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
    expect(context).toContain("Use git_bash MCP for every shell command.");
    expect(context).toContain("load caveman skill first");
    expect(context).toContain("Primary agent keeps control.");
    expect(context).toContain("Subagents reduce cost, never simulate an organization.");
    expect(context).toContain("Delegate bounded labor, never responsibility.");
    expect(context).toContain("Spend intelligence only where complexity requires it.");
  });
});
