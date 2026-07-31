import { describe, expect, it } from "vitest";

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
    expect(installResult).toEqual({ status: "skipped", reason: "unauthenticated" });
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
    });
  });

  it("reports a plugin missing from the loaded catalog", async () => {
    const fake = runner([result(JSON.stringify({ installed: [], available: [] }))]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "skipped",
      reason: "plugin-unavailable",
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
    });
  });
});
