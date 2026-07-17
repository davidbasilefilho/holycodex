import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { VERSION } from "../packages/cli/src/catalog";

const run = promisify(execFile);

describe("CLI", () => {
  it("prints version under Node", async () => {
    const result = await run(process.execPath, ["packages/cli/src/cli.ts", "--version"]);
    expect(result.stdout).toBe(`${VERSION}\n`);
  });

  it("supports the short version alias", async () => {
    const result = await run(process.execPath, ["packages/cli/src/cli.ts", "-v"]);
    expect(result.stdout).toBe(`${VERSION}\n`);
  });

  it("documents all autonomy modes and doctor output", async () => {
    const result = await run(process.execPath, ["packages/cli/src/cli.ts", "--help"]);
    expect(result.stdout).toContain("--codex-autonomous");
    expect(result.stdout).toContain("--dangerous-codex-autonomous");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("--json");
  });

  it("supports the short help alias", async () => {
    const result = await run(process.execPath, ["packages/cli/src/cli.ts", "-h"]);
    expect(result.stdout).toContain(`HOLYCODEX ${VERSION}`);
    expect(result.stdout).toContain("USAGE");
  });

  it("prints a concise error for an unknown command", async () => {
    await expect(
      run(process.execPath, ["packages/cli/src/cli.ts", "definitely-not-a-command"]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringMatching(
        /^✗ ERROR  Unknown command: definitely-not-a-command\r?\n  Run holycodex --help for usage\.\r?\n$/,
      ),
    });
  });

  it("rejects conflicting autonomy flags", async () => {
    await expect(
      run(process.execPath, [
        "packages/cli/src/cli.ts",
        "install",
        "--codex-autonomous",
        "--dangerous-codex-autonomous",
      ]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("Conflicting autonomy flags") });
  });

  it("uses safe interactive permissions by default", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    await run(process.execPath, ["packages/cli/src/cli.ts", "install", "--json"], {
      env: { ...process.env, CODEX_HOME: home },
    });

    const config = await readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain('approval_policy = "on-request"');
    expect(config).toContain('sandbox_mode = "workspace-write"');
  });

  it("keeps the safe defaults with --no-codex-autonomous", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    await run(process.execPath, ["packages/cli/src/cli.ts", "install", "--no-codex-autonomous"], {
      env: { ...process.env, CODEX_HOME: home },
    });

    const config = await readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain('approval_policy = "on-request"');
    expect(config).toContain('sandbox_mode = "workspace-write"');
  });

  it("supports sandboxed and explicitly dangerous autonomy", async () => {
    const safeHome = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const safeResult = await run(
      process.execPath,
      ["packages/cli/src/cli.ts", "install", "--codex-autonomous"],
      {
        env: { ...process.env, CODEX_HOME: safeHome },
      },
    );
    const safe = await readFile(join(safeHome, "config.toml"), "utf8");
    expect(safe).toContain('approval_policy = "never"');
    expect(safe).toContain('sandbox_mode = "workspace-write"');
    expect(safeResult.stderr).toContain("is now workspace-contained");
    expect(safeResult.stderr).toContain("--dangerous-codex-autonomous");

    const dangerHome = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    const result = await run(
      process.execPath,
      ["packages/cli/src/cli.ts", "install", "--dangerous-codex-autonomous"],
      { env: { ...process.env, CODEX_HOME: dangerHome } },
    );
    const danger = await readFile(join(dangerHome, "config.toml"), "utf8");
    expect(danger).toContain('sandbox_mode = "danger-full-access"');
    expect(result.stderr).toContain("WARNING");
  });

  it("prints comprehensive doctor JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cli-"));
    await run(process.execPath, ["packages/cli/src/cli.ts", "install"], {
      env: { ...process.env, CODEX_HOME: home },
    });
    let stdout: string;
    try {
      stdout = (
        await run(process.execPath, ["packages/cli/src/cli.ts", "doctor", "--json"], {
          env: { ...process.env, CODEX_HOME: home },
        })
      ).stdout;
    } catch (error) {
      if (!(error instanceof Error) || !("stdout" in error) || typeof error.stdout !== "string")
        throw error;
      stdout = error.stdout;
    }
    const report = JSON.parse(stdout) as {
      healthy: boolean;
      checks: Array<{ id: string }>;
    };
    expect(report.healthy).toEqual(expect.any(Boolean));
    expect(report.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining([
        "package",
        "context7-config",
        "context7-startup",
        "git-bash",
        "autonomy",
        "context-visibility",
      ]),
    );
  }, 15_000);
});
