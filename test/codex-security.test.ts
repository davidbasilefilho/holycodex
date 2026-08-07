import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createCodexLauncherCandidates,
  defaultCodexLauncherRuntimeFacts,
} from "../packages/cli/src/codex-launcher.ts";
import {
  installBuildWebApps,
  installComputerUse,
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

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/codex-security/${name}`, import.meta.url), "utf8");
}

const available = fixture("catalog-available.json");
const installedOnly = JSON.stringify({ installed: [], available: [] });
const added = JSON.stringify({ pluginId: "codex-security@openai-curated" });
const enabled = fixture("catalog-enabled.json");
const marketplaceAvailable = fixture("catalog-marketplace-available.json");
const marketplaceEnabled = fixture("catalog-marketplace-enabled.json");
const marketplaceDisabled = fixture("catalog-marketplace-disabled.json");
const marketplaceAbsent = fixture("marketplaces-openai-bundled.json");
const oversizedAvailable = JSON.stringify({
  installed: [],
  available: [
    { pluginId: "codex-security@openai-curated", installed: false, enabled: false },
    ...Array.from({ length: 2_000 }, (_, index) => ({
      pluginId: `example-plugin-${index}@openai-curated`,
      installed: false,
      enabled: false,
    })),
  ],
});

describe("official plugin installation", () => {
  it("installs and verifies the official Build Web Apps plugin", async () => {
    const pluginId = "build-web-apps@openai-curated";
    const fake = runner([
      result(installedOnly),
      result(
        JSON.stringify({
          installed: [],
          available: [{ pluginId, installed: false, enabled: false }],
        }),
      ),
      result("{}"),
      result(
        JSON.stringify({
          installed: [{ pluginId, installed: true, enabled: true }],
          available: [],
        }),
      ),
    ]);

    await expect(installBuildWebApps(fake.run, "linux", {})).resolves.toMatchObject({
      status: "installed",
    });
    expect(fake.calls.some(({ args }) => args.includes(pluginId))).toBe(true);
  });

  it("retries a transient PATH catalog failure before downloading Codex", async () => {
    const fake = runner([
      result("", { exitCode: 1, stderr: "temporary network failure" }),
      result(
        JSON.stringify({
          installed: [
            {
              pluginId: "computer-use@openai-bundled",
              installed: true,
              enabled: true,
            },
          ],
          available: [],
        }),
      ),
    ]);

    await expect(
      installComputerUse(
        fake.run,
        "win32",
        {},
        {
          runtimeFacts: {
            platform: "win32",
            runtime: "node",
            availableRunners: ["npm", "pnpm"],
          },
        },
      ),
    ).resolves.toEqual({ status: "already-installed", launcherSource: "path" });
    expect(fake.calls.map(({ command }) => command)).toEqual(["codex", "codex"]);
  });

  it("installs and verifies the official Computer Use plugin", async () => {
    const fake = runner([
      result(JSON.stringify({ installed: [], available: [] })),
      result(
        JSON.stringify({
          installed: [],
          available: [
            { pluginId: "computer-use@openai-bundled", installed: false, enabled: false },
          ],
        }),
      ),
      result("{}"),
      result(
        JSON.stringify({
          installed: [{ pluginId: "computer-use@openai-bundled", installed: true, enabled: true }],
          available: [],
        }),
      ),
    ]);

    await expect(installComputerUse(fake.run, "linux", {})).resolves.toMatchObject({
      status: "installed",
    });
    expect(fake.calls.some(({ args }) => args.includes("computer-use@openai-bundled"))).toBe(true);
  });
  it("parses diagnostic-prefixed and JSONL catalog output", async () => {
    const fake = runner([
      result(`notice: using current profile\n${installedOnly}`),
      result(
        `${JSON.stringify({ event: "catalog" })}\n${JSON.stringify({
          installed: [],
          available: [
            { pluginId: "codex-security@openai-curated", installed: false, enabled: false },
          ],
        })}`,
      ),
      result(""),
      result(enabled),
    ]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "installed",
      launcherSource: "path",
    });
  });

  it("rejects trailing non-JSON output after a catalog document", async () => {
    const fake = runner([
      result(`${installedOnly}\nnot-json`),
      result(installedOnly),
      result(available),
      result(""),
      result(enabled),
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
    ).resolves.toEqual({ status: "installed", launcherSource: "bunx" });
  });

  it("reports a failed authoritative post-add verification", async () => {
    const fake = runner([
      result(installedOnly),
      result(available),
      result(""),
      result(JSON.stringify({ installed: [], available: [] })),
    ]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "skipped",
      reason: "verification-failed",
      attemptedLaunchers: ["path"],
    });
  });

  it("distinguishes an absent official marketplace from a marketplace that lacks the plugin", async () => {
    const marketplacePresent = JSON.stringify({
      marketplaces: [{ name: "openai-curated", root: "/safe/openai-curated" }],
    });
    const absent = runner([
      result(installedOnly),
      result(installedOnly),
      result(marketplaceAbsent),
    ]);
    await expect(installCodexSecurity(absent.run, "linux", {})).resolves.toEqual({
      status: "skipped",
      reason: "marketplace-unavailable",
      attemptedLaunchers: ["path"],
    });
    expect(absent.calls[2]?.args).toEqual(["plugin", "marketplace", "list", "--json"]);

    const notOffered = runner([
      result(installedOnly),
      result(installedOnly),
      result(marketplacePresent),
    ]);
    await expect(installCodexSecurity(notOffered.run, "linux", {})).resolves.toEqual({
      status: "skipped",
      reason: "all-launchers-lacked-plugin",
      attemptedLaunchers: ["path"],
    });
  });

  it("queries installed state separately, accepts an empty add response, and verifies installed enabled state", async () => {
    const fake = runner([result(installedOnly), result(available), result(""), result(enabled)]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "installed",
      launcherSource: "path",
    });
    expect(fake.calls).toEqual([
      { command: "codex", args: ["plugin", "list", "--json"] },
      { command: "codex", args: ["plugin", "list", "--available", "--json"] },
      {
        command: "codex",
        args: ["plugin", "add", "codex-security@openai-curated", "--json"],
      },
      { command: "codex", args: ["plugin", "list", "--json"] },
    ]);
  });

  it("installs the available official plugin with fixed argv", async () => {
    const fake = runner([result(installedOnly), result(available), result(added), result(enabled)]);
    const env = { CODEX_HOME: "/tmp/codex-home", PATH: "/bin" };
    await expect(installCodexSecurity(fake.run, "linux", env)).resolves.toEqual({
      status: "installed",
      launcherSource: "path",
    });
    expect(fake.calls).toEqual([
      { command: "codex", args: ["plugin", "list", "--json"] },
      { command: "codex", args: ["plugin", "list", "--available", "--json"] },
      {
        command: "codex",
        args: ["plugin", "add", "codex-security@openai-curated", "--json"],
      },
      { command: "codex", args: ["plugin", "list", "--json"] },
    ]);
  });

  it("captures oversized available catalogs before installing and verifying", async () => {
    const requestedLimits: number[] = [];
    const oversizedResponses: Record<string, string> = {
      "plugin list --json": installedOnly,
      "plugin list --available --json": oversizedAvailable,
      "plugin add codex-security@openai-curated --json": "",
    };
    const run: CodexProcessRunner = async (input) => {
      requestedLimits.push(input.maxOutputChars);
      const key = input.args.join(" ");
      if (key === "plugin list --json" && requestedLimits.length > 1) return result(enabled);
      const stdout = oversizedResponses[key];
      if (stdout === undefined) throw new Error(`Unexpected process call: ${key}`);
      if (input.maxOutputChars <= 64 * 1024)
        return result(stdout.slice(0, input.maxOutputChars), { outputTruncated: true });
      return result(stdout);
    };

    expect(oversizedAvailable.length).toBeGreaterThan(64 * 1024);
    await expect(installCodexSecurity(run, "linux", {})).resolves.toEqual({
      status: "installed",
      launcherSource: "path",
    });
    expect(requestedLimits).toEqual([256 * 1024, 256 * 1024, 256 * 1024, 256 * 1024]);
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
      result(enabled),
    ]);
    await expect(installCodexSecurity(fake.run, "darwin", {})).resolves.toEqual({
      status: "enabled",
      launcherSource: "path",
    });
  });

  it("normalizes current marketplace-oriented output and installs the plugin", async () => {
    const fake = runner([
      result(installedOnly),
      result(marketplaceAvailable),
      result(added),
      result(marketplaceEnabled),
    ]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "installed",
      launcherSource: "path",
    });
  });

  it("recognizes a marketplace plugin already installed and enabled", async () => {
    const fake = runner([result(marketplaceEnabled)]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "already-installed",
      launcherSource: "path",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("enables a disabled marketplace plugin and verifies the result", async () => {
    const fake = runner([result(marketplaceDisabled), result(added), result(marketplaceEnabled)]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
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
    const fake = runner([
      result(JSON.stringify({ installed: [], available: [] })),
      result("", {
        exitCode: 1,
        stderr: JSON.stringify({ error: { code: "PLUGIN_NOT_FOUND" } }),
      }),
    ]);
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
      return inputs.length === 2
        ? result(installedOnly)
        : inputs.length === 3
          ? result(available)
          : inputs.length === 4
            ? result(added)
            : result(enabled);
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
      ["codex", ["plugin", "list", "--json"]],
      ["C:\\bun\\bun.exe", ["x", "@openai/codex@latest", "plugin", "list", "--json"]],
      [
        "C:\\bun\\bun.exe",
        ["x", "@openai/codex@latest", "plugin", "list", "--available", "--json"],
      ],
      [
        "C:\\bun\\bun.exe",
        ["x", "@openai/codex@latest", "plugin", "add", "codex-security@openai-curated", "--json"],
      ],
      ["C:\\bun\\bun.exe", ["x", "@openai/codex@latest", "plugin", "list", "--json"]],
    ]);
    expect(inputs[1]?.env).toEqual({ CODEX_HOME: "C:\\safe\\codex", SECRET: "hidden" });
  });

  it("falls through a PATH Codex that lacks the plugin subcommand", async () => {
    const inputs: Parameters<CodexProcessRunner>[0][] = [];
    const run: CodexProcessRunner = async (input) => {
      inputs.push(input);
      if (inputs.length === 1) return result("", { exitCode: 1, stderr: "unknown command plugin" });
      return inputs.length === 2
        ? result(installedOnly)
        : inputs.length === 3
          ? result(available)
          : inputs.length === 4
            ? result(added)
            : result(enabled);
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
    expect(inputs.map((input) => input.command)).toEqual(["codex", "bun", "bun", "bun", "bun"]);
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

  it("preserves an authoritative marketplace failure over package download failures", async () => {
    const fake = runner([
      result(installedOnly),
      result(installedOnly),
      result(JSON.stringify({ marketplaces: [{ name: "openai-curated" }] })),
      result("", { exitCode: 1, stderr: "network fetch failed" }),
    ]);

    await expect(
      installComputerUse(
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
      attemptedLaunchers: ["path", "bunx"],
    });
  });

  it("falls through marketplace failures before returning a nonfatal result", async () => {
    const fake = runner([
      result("", {
        exitCode: 1,
        stderr: "marketplace network request failed while loading plugins",
      }),
      result("", {
        exitCode: 1,
        stderr: "marketplace network request failed while loading plugins",
      }),
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
      attemptedLaunchers: ["path", "bunx"],
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("falls through a valid catalog omission to the next launcher", async () => {
    const fake = runner([
      result(installedOnly),
      result(JSON.stringify({ installed: [], available: [] })),
      result(marketplaceAbsent),
      result(installedOnly),
      result(available),
      result(added),
      result(enabled),
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
    ).resolves.toEqual({ status: "installed", launcherSource: "bunx" });
    expect(fake.calls.map((call) => call.command)).toEqual([
      "codex",
      "codex",
      "codex",
      "bun",
      "bun",
      "bun",
      "bun",
    ]);
  });

  it("falls through a plugin-not-found response to the next launcher", async () => {
    const fake = runner([
      result("", { exitCode: 1, stderr: JSON.stringify({ error: { code: "PLUGIN_NOT_FOUND" } }) }),
      result(installedOnly),
      result(available),
      result(added),
      result(enabled),
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
    ).resolves.toEqual({ status: "installed", launcherSource: "bunx" });
  });

  it("rejects malformed required catalog fields and continues deterministically", async () => {
    const fake = runner([
      result(JSON.stringify({ installed: "invalid", available: [] })),
      result(installedOnly),
      result(available),
      result(added),
      result(enabled),
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
    ).resolves.toEqual({ status: "installed", launcherSource: "bunx" });
  });

  it("normalizes catalog identifiers while requiring the exact official add identifier", async () => {
    const fake = runner([
      result(installedOnly),
      result(
        JSON.stringify({
          installed: [],
          available: [
            { pluginId: " codex-security@openai-curated ", installed: false, enabled: false },
          ],
          ignored: { future: true },
        }),
      ),
      result(added),
      result(enabled),
    ]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "installed",
      launcherSource: "path",
    });
    expect(fake.calls[2]?.args).toEqual([
      "plugin",
      "add",
      "codex-security@openai-curated",
      "--json",
    ]);
  });

  it("does not report installation until a fresh catalog verifies enabled state", async () => {
    const fake = runner([
      result(installedOnly),
      result(available),
      result(added),
      result(JSON.stringify({ installed: [], available: [] })),
    ]);
    await expect(installCodexSecurity(fake.run, "linux", {})).resolves.toEqual({
      status: "skipped",
      reason: "verification-failed",
      attemptedLaunchers: ["path"],
    });
  });

  it("derives package-manager candidates for the default runtime facts", () => {
    const facts = defaultCodexLauncherRuntimeFacts("linux");
    const candidates = createCodexLauncherCandidates({ runtimeFacts: facts });
    expect(candidates.map((candidate) => candidate.source)).toContain("npm-exec");
    expect(candidates.map((candidate) => candidate.source)).toContain("pnpm-exec");
  });

  it("skips package resolution at the CLI integration-test boundary", () => {
    const facts = defaultCodexLauncherRuntimeFacts("linux", {
      HOLYCODEX_TEST_SKIP_PACKAGE_RESOLUTION: "1",
      npm_execpath: "/private/npm-cli.js",
    });
    const candidates = createCodexLauncherCandidates({ runtimeFacts: facts });
    expect(candidates).toEqual([{ command: "codex", argsPrefix: [], source: "path" }]);
  });
});
