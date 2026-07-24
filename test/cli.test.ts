import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { VERSION } from "../packages/cli/src/catalog";

const run = promisify(execFile);
process.env.HOLYCODEX_TEST_SKIP_PACKAGE_RESOLUTION = "1";

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

  it("documents every install plan and example", async () => {
    const result = await run(process.execPath, ["packages/cli/src/cli.ts", "install", "--help"]);
    expect(result.stdout).toContain("go, plus-low, plus, plus-high, pro-5x, or pro-20x");
    expect(result.stdout).toContain("Default: plus");
    expect(result.stdout).toContain("bunx holycodex install --plan go");
    expect(result.stdout).toContain("bunx holycodex install --plan plus-low");
    expect(result.stdout).toContain("bunx holycodex install --plan plus-high");
    expect(result.stdout).toContain("bunx holycodex install --plan pro-20x");
  });

  it.each(["go", "plus-low", "plus", "plus-high", "pro-5x", "pro-20x"])(
    "accepts plan %s with flags in either order",
    async (plan) => {
      const home = await mkdtemp(join(tmpdir(), "holycodex-cli-plan-"));
      const result = await run(
        process.execPath,
        [
          "packages/cli/src/cli.ts",
          "--json",
          "--plan",
          plan,
          "install",
          "--no-tui",
          "--no-codex-autonomous",
        ],
        { env: { ...process.env, CODEX_HOME: home } },
      );
      expect(JSON.parse(result.stdout)).toMatchObject({ action: "install", plan });
    },
  );

  it("rejects missing and unknown plan values", async () => {
    await expect(
      run(process.execPath, ["packages/cli/src/cli.ts", "install", "--plan"]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("Missing --plan value") });
    await expect(
      run(process.execPath, ["packages/cli/src/cli.ts", "install", "--plan", "enterprise"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        "Valid plans: go, plus-low, plus, plus-high, pro-5x, pro-20x",
      ),
    });
  });

  it("maps --max-subagents to root-inclusive max_threads", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cli-subagents-"));
    const result = await run(
      process.execPath,
      [
        "packages/cli/src/cli.ts",
        "--max-subagents",
        "3",
        "install",
        "--json",
        "--plan",
        "plus-low",
      ],
      { env: { ...process.env, CODEX_HOME: home } },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({ plan: "plus-low", maxSubagents: 3 });
    const config = await readFile(join(home, "config.toml"), "utf8");
    expect(config).toContain("# holycodex max-subagents: 3");
    expect(config).toContain("max_threads = 4");
  });

  it.each([
    [["install", "--max-subagents"], "Missing --max-subagents value"],
    [["install", "--max-subagents", "-1"], "Invalid --max-subagents value: -1"],
    [["install", "--max-subagents", "1.5"], "Invalid --max-subagents value: 1.5"],
    [
      ["install", "--max-subagents", "1", "--max-subagents", "2"],
      "--max-subagents may be specified only once",
    ],
  ])("rejects invalid max-subagents arguments %#", async (arguments_, message) => {
    await expect(
      run(process.execPath, ["packages/cli/src/cli.ts", ...arguments_]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
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

  it("rejects a stray positional before a valid command", async () => {
    const home = await mkdtemp(join(tmpdir(), "holycodex-cli-stray-positional-"));
    await expect(
      run(process.execPath, ["packages/cli/src/cli.ts", "typo", "cleanup"], {
        env: { ...process.env, CODEX_HOME: home },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown command: typo"),
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
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringMatching(
        /^✗ ERROR  Conflicting autonomy flags: --codex-autonomous, --dangerous-codex-autonomous\r?\n  Run holycodex --help for usage\.\r?\n$/,
      ),
    });
  });

  it.runIf(process.platform === "win32")(
    "renders Git Bash preflight failures without a stack trace",
    async () => {
      await expect(
        run(process.execPath, ["packages/cli/src/cli.ts", "install"], {
          env: {
            ...process.env,
            HOLYCODEX_GIT_BASH_PATH: "C:\\missing\\bash.exe",
          },
        }),
      ).rejects.toMatchObject({
        code: 1,
        stdout: "",
        stderr: expect.not.stringContaining("at "),
      });
    },
  );

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
        "bun",
        "bunx",
        "git-bash",
        "autonomy",
        "routing-plan",
        "context-visibility",
      ]),
    );
  }, 15_000);
});
