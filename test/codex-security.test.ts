import { describe, expect, it } from "vitest";

import {
  createCodexLauncherCandidates,
  defaultCodexLauncherRuntimeFacts,
} from "../packages/cli/src/codex-launcher.ts";
import {
  installCodexSecurity,
  type CodexProcessRunner,
} from "../packages/cli/src/codex-security.ts";

function result(
  stdout = "",
  overrides: Partial<Awaited<ReturnType<CodexProcessRunner>>> = {},
): Awaited<ReturnType<CodexProcessRunner>> {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    matched: false,
    outputTruncated: false,
    ...overrides,
  };
}

function runner(responses: readonly Awaited<ReturnType<CodexProcessRunner>>[]): {
  readonly calls: Array<{ readonly command: string; readonly args: readonly string[] }>;
  readonly run: CodexProcessRunner;
} {
  const calls: Array<{ readonly command: string; readonly args: readonly string[] }> = [];
  return {
    calls,
    run: async (input) => {
      calls.push({ command: input.command, args: input.args });
      const response = responses[calls.length - 1];
      if (response === undefined) throw new Error("Unexpected process call.");
      return response;
    },
  };
}

const available = JSON.stringify({
  installed: [],
  available: [{ pluginId: "codex-security@openai-curated", installed: false, enabled: false }],
});
const added = JSON.stringify({ pluginId: "codex-security@openai-curated" });

describe("Codex Security installation", () => {
  it("installs the available official plugin with fixed argv", async () => {
    const fake = runner([result(available), result(added)]);
    const env = { CODEX_HOME: "/tmp/codex-home", PATH: "/bin" };
    await expect(installCodexSecurity(fake.run, "linux", env)).resolves.toEqual({
      status: "installed",
      launcherSource: "path",
    });
    expect(fake.calls).toEqual([
      { command: "codex", args: ["plugin", "list", "--available", "--json"] },
      {
        command: "codex",
        args: ["plugin", "add", "codex-security@openai-curated", "--json"],
      },
    ]);
  });

  it("passes the active environment without exposing failed-command diagnostics", async () => {
    const inputs: Parameters<CodexProcessRunner>[0][] = [];
    const env = { CODEX_HOME: "/tmp/active-home", SECRET_TOKEN: "do-not-print" };
    const run: CodexProcessRunner = async (input) => {
      inputs.push(input);
      return result("", {
        exitCode: 1,
        stderr: JSON.stringify({ error: { code: "UNAUTHENTICATED", token: env.SECRET_TOKEN } }),
      });
    };
    const installResult = await installCodexSecurity(run, "linux", env);
    expect(inputs[0]?.env).toBe(env);
    expect(installResult).toEqual({
      status: "skipped",
      reason: "unauthenticated",
      attemptedLaunchers: ["path"],
    });
    expect(JSON.stringify(installResult)).not.toContain(env.SECRET_TOKEN);
  });

  it("does nothing when the plugin is already installed and enabled", async () => {
    const fake = runner([
      result(
        JSON.stringify({
          installed: [
            { pluginId: "codex-security@openai-curated", installed: true, enabled: true },
          ],
          available: [],
        }),
      ),
    ]);
    await expect(installCodexSecurity(fake.run, "win32", {})).resolves.toEqual({
      status: "already-installed",
      launcherSource: "path",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("enables an installed but disabled plugin through plugin add", async () => {
    const fake = runner([
      result(
        JSON.stringify({
          installed: [
            { pluginId: "codex-security@openai-curated", installed: true, enabled: false },
          ],
          available: [],
        }),
      ),
      result(added),
    ]);
    await expect(installCodexSecurity(fake.run, "darwin", {})).resolves.toEqual({
      status: "enabled",
      launcherSource: "path",
    });
  });

  it.each([
    ["codex-unavailable", result("", { exitCode: null, error: "spawn ENOENT" })],
    ["timeout", result("", { exitCode: null, timedOut: true })],
    [
      "unauthenticated",
      result("", { exitCode: 1, stderr: JSON.stringify({ error: { code: "UNAUTHENTICATED" } }) }),
    ],
    [
      "marketplace-unavailable",
      result("", {
        exitCode: 1,
        stderr: JSON.stringify({ error: { code: "MARKETPLACE_UNAVAILABLE" } }),
      }),
    ],
    [
      "installation-rejected",
      result("", {
        exitCode: 1,
        stderr: JSON.stringify({ error: { code: "INSTALLATION_REJECTED" } }),
      }),
    ],
    ["invalid-response", result("not json")],
  ] as const)("returns a non-fatal %s result", async (reason, response) => {
    const fake = runner([response]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "skipped",
      reason,
      attemptedLaunchers: ["path"],
    });
  });

  it("reports a plugin missing from the loaded catalog", async () => {
    const fake = runner([result(JSON.stringify({ installed: [], available: [] }))]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "skipped",
      reason: "plugin-unavailable",
      attemptedLaunchers: ["path"],
    });
  });

  it("propagates internal runner failures", async () => {
    const run: CodexProcessRunner = async () => {
      throw new Error("internal runner contract failed");
    };
    await expect(installCodexSecurity(run, "linux", {})).rejects.toThrow(
      "internal runner contract failed",
    );
  });

  it("treats synchronous executable spawn failures as non-fatal", async () => {
    const run: CodexProcessRunner = async () => {
      throw Object.assign(new Error("spawn blocked"), { code: "EPERM" });
    };
    await expect(installCodexSecurity(run, "win32", {})).resolves.toEqual({
      status: "skipped",
      reason: "codex-unavailable",
      attemptedLaunchers: ["path"],
    });
  });

  it("derives the ordered Windows Bun launcher without exposing its executable path", () => {
    const candidates = createCodexLauncherCandidates({
      runtimeFacts: {
        platform: "win32",
        runtime: "bun",
        execPath: "C:\\Users\\secret\\bun.exe",
        availableRunners: [],
      },
    });
    expect(candidates).toEqual([
      { command: "codex", argsPrefix: [], source: "path" },
      {
        command: "C:\\Users\\secret\\bun.exe",
        argsPrefix: ["x", "@openai/codex@latest"],
        source: "bunx",
      },
    ]);
    expect(candidates.map((candidate) => candidate.source)).not.toContain(
      "C:\\Users\\secret\\bun.exe",
    );
  });

  it("tries an injected launcher before PATH", () => {
    expect(
      createCodexLauncherCandidates({
        injected: {
          command: "test-codex",
          argsPrefix: ["--literal=;echo unsafe"],
          source: "injected",
        },
        runtimeFacts: { runtime: "node", availableRunners: [] },
      }),
    ).toEqual([
      {
        command: "test-codex",
        argsPrefix: ["--literal=;echo unsafe"],
        source: "injected",
      },
      { command: "codex", argsPrefix: [], source: "path" },
    ]);
  });

  it("uses a recognized active pnpm runner and safe pnpm argv", () => {
    const candidates = createCodexLauncherCandidates({
      runtimeFacts: {
        runtime: "node",
        execPath: "node",
        npmExecPath: "/usr/local/bin/pnpm.cjs",
        availableRunners: [],
      },
    });
    expect(candidates).toEqual([
      { command: "codex", argsPrefix: [], source: "path" },
      {
        command: "node",
        argsPrefix: ["/usr/local/bin/pnpm.cjs", "dlx", "@openai/codex@latest"],
        source: "pnpm-exec",
      },
    ]);
  });

  it("uses package bootstrap timeout for probes and operational timeout for add", async () => {
    const inputs: Parameters<CodexProcessRunner>[0][] = [];
    const run: CodexProcessRunner = async (input) => {
      inputs.push(input);
      if (inputs.length === 1)
        return result("", { exitCode: null, error: "spawn ENOENT", errorCode: "ENOENT" });
      if (inputs.length === 2) return result("", { timedOut: true, exitCode: null });
      return result(added);
    };
    const installResult = await installCodexSecurity(
      run,
      "linux",
      {},
      {
        runtimeFacts: {
          runtime: "bun",
          execPath: "bun",
          availableRunners: [],
        },
      },
    );
    expect(installResult).toEqual({
      status: "skipped",
      reason: "timeout",
      attemptedLaunchers: ["path", "bunx"],
    });
    expect(inputs.map((input) => input.timeoutMs)).toEqual([15_000, 120_000]);
  });

  it("falls through an unavailable PATH launcher and reuses one selected package launcher", async () => {
    const inputs: Parameters<CodexProcessRunner>[0][] = [];
    const run: CodexProcessRunner = async (input) => {
      inputs.push(input);
      if (inputs.length === 1)
        return result("", { exitCode: null, error: "spawn ENOENT", errorCode: "ENOENT" });
      return inputs.length === 2 ? result(available) : result(added);
    };
    await expect(
      installCodexSecurity(
        run,
        "win32",
        { CODEX_HOME: "C:\\safe\\codex", SECRET: "hidden" },
        {
          runtimeFacts: { runtime: "bun", execPath: "C:\\bun\\bun.exe", availableRunners: [] },
        },
      ),
    ).resolves.toEqual({ status: "installed", launcherSource: "bunx" });
    expect(inputs.map((input) => [input.command, input.args])).toEqual([
      ["codex", ["plugin", "list", "--available", "--json"]],
      [
        "C:\\bun\\bun.exe",
        ["x", "@openai/codex@latest", "plugin", "list", "--available", "--json"],
      ],
      [
        "C:\\bun\\bun.exe",
        ["x", "@openai/codex@latest", "plugin", "add", "codex-security@openai-curated", "--json"],
      ],
    ]);
    expect(inputs[1]?.env).toEqual({ CODEX_HOME: "C:\\safe\\codex", SECRET: "hidden" });
  });

  it("falls through a PATH Codex that lacks the plugin subcommand", async () => {
    const inputs: Parameters<CodexProcessRunner>[0][] = [];
    const run: CodexProcessRunner = async (input) => {
      inputs.push(input);
      if (inputs.length === 1) return result("", { exitCode: 1, stderr: "unknown command plugin" });
      return inputs.length === 2 ? result(available) : result(added);
    };
    await expect(
      installCodexSecurity(
        run,
        "linux",
        {},
        {
          runtimeFacts: { runtime: "bun", execPath: "bun", availableRunners: [] },
        },
      ),
    ).resolves.toEqual({ status: "installed", launcherSource: "bunx" });
    expect(inputs.map((input) => input.command)).toEqual(["codex", "bun", "bun"]);
  });

  it("reports every unavailable launcher source without leaking paths", async () => {
    const run: CodexProcessRunner = async () =>
      result("", {
        exitCode: null,
        error: "spawn ENOENT C:\\private\\secret",
        errorCode: "ENOENT",
      });
    await expect(
      installCodexSecurity(
        run,
        "win32",
        {},
        {
          runtimeFacts: {
            runtime: "bun",
            execPath: "C:\\private\\bun.exe",
            availableRunners: ["npm", "pnpm"],
          },
        },
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "codex-unavailable",
      attemptedLaunchers: ["path", "bunx", "npm-exec", "pnpm-exec"],
    });
  });

  it("reports network fallback and redacts attempted launcher details", async () => {
    const run: CodexProcessRunner = async (input) => {
      if (input.command === "codex")
        return result("", { exitCode: null, error: "spawn ENOENT", errorCode: "ENOENT" });
      return result("", {
        exitCode: 1,
        stderr: "network fetch failed token=super-secret C:\\Users\\secret\\npm-cache",
      });
    };
    await expect(
      installCodexSecurity(
        run,
        "win32",
        {},
        {
          runtimeFacts: { runtime: "bun", execPath: "C:\\private\\bun.exe", availableRunners: [] },
        },
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "download-failed",
      attemptedLaunchers: ["path", "bunx"],
    });
  });

  it("classifies a supported PATH marketplace network failure without trying runners", async () => {
    const fake = runner([
      result("", { exitCode: 1, stderr: "network request failed while loading plugins" }),
    ]);
    await expect(
      installCodexSecurity(
        fake.run,
        "linux",
        {},
        {
          runtimeFacts: { runtime: "bun", execPath: "bun", availableRunners: [] },
        },
      ),
    ).resolves.toEqual({
      status: "skipped",
      reason: "marketplace-unavailable",
      attemptedLaunchers: ["path"],
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("derives package-manager candidates for the default runtime facts", () => {
    const facts = defaultCodexLauncherRuntimeFacts("linux");
    const candidates = createCodexLauncherCandidates({ runtimeFacts: facts });
    expect(candidates.map((candidate) => candidate.source)).toContain("npm-exec");
    expect(candidates.map((candidate) => candidate.source)).toContain("pnpm-exec");
  });
});
