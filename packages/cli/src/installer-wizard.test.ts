// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArgv,
  renderInstallWizardReview,
  rootDeveloperInstructions,
  projectNativeAgents,
  renderNativeAgent,
  runCli,
  toInstallOptions,
  type InstallOptions,
  type InstallRequest,
} from "./index.ts";

describe("public install wizard contract", () => {
  test("classifies removed plan flags and spellings without treating them as live profiles", () => {
    expect(() => parseArgv(["install", "--plan", "Go"])).toThrow(
      "The --plan option was removed; use --profile",
    );
    expect(() => parseArgv(["install", "--plan", "plus"])).toThrow(
      "The --plan option was removed; use --profile",
    );
    expect(() => parseArgv(["install", "--plan", "pro-5x"])).toThrow(
      "The --plan option was removed; use --profile",
    );
  });

  test("renders one final review containing exactly the semantic install choices", () => {
    const review = renderInstallWizardReview({
      profile: "default",
      tier: "fast-all",
      optional: {
        work: true,
        frontend: false,
        security: true,
        computer_use: true,
      },
      officialPlugins: ["example@marketplace"],
    });

    expect(review).toContain("Review configuration");
    expect(review).toContain("Profile: default");
    expect(review).toContain("Service tier: fast-all");
    expect(review).toContain("Work: enabled");
    expect(review).toContain("Frontend: disabled");
    expect(review).toContain("Security: enabled");
    expect(review).toContain("Computer Use: enabled");
    expect(review).toContain("Additional plugins: example@marketplace");
    expect(review).toContain("Install");
    expect(review).toContain("Change options / Redo");
    expect(review).toContain("Cancel");
    expect(review).not.toContain("CODEX_HOME");
  });

  test("uses the same Effect-validated request shape as flags", () => {
    const initial: InstallRequest = {
      profile: "high",
      tier: "standard",
      optional: { work: true, frontend: true, security: false, computer_use: false },
      officialPlugins: ["one@marketplace", "one@marketplace"],
    };
    const options = toInstallOptions({
      profile: initial.profile!,
      tier: initial.tier!,
      optional: {
        work: initial.optional?.work ?? false,
        frontend: initial.optional?.frontend ?? false,
        security: initial.optional?.security ?? false,
        computer_use: initial.optional?.computer_use ?? false,
      },
      plugins: [...initial.officialPlugins!],
      pluginInput: initial.officialPlugins!.join(", "),
    });
    expect(options).toEqual({
      profile: "high",
      tier: "standard",
      optional: { work: true, frontend: true, security: false, computer_use: false },
      officialPlugins: ["one@marketplace", "one@marketplace"],
    } satisfies InstallOptions);
  });
});

describe("generated Root orchestration policy", () => {
  test("requires delegation while preserving the conditional Computer Use exception", () => {
    const withoutComputerUse = rootDeveloperInstructions(false);
    expect(withoutComputerUse).toContain("MUST orchestrate and delegate every task");
    expect(withoutComputerUse).toContain("Git/VCS is always Root-only");
    expect(withoutComputerUse).toContain("Computer Use is not selected");
    expect(withoutComputerUse).toContain("delegate GUI, browser, and Computer Use execution");
    expect(withoutComputerUse).toContain("before plan approval");
    expect(withoutComputerUse).toContain("remote/origin/server VCS mutation");
    expect(withoutComputerUse).toContain("Bias toward action");
    expect(withoutComputerUse).toContain(
      "finish all authorized read-only, reversible, preparatory, and independent work",
    );
    expect(withoutComputerUse).toContain("installation profile approval");
    expect(withoutComputerUse).toContain(
      "Dispatch independent, non-overlapping Assignments concurrently",
    );
    expect(withoutComputerUse).toContain("reload only when it no longer does");
    expect(withoutComputerUse).toContain("model_verbosity = low");
    expect(withoutComputerUse).toContain("no actionable finding remains within scope");
    expect(withoutComputerUse).toContain("Reviewer.code fixed-point review is mandatory");
    expect(withoutComputerUse).toContain("exact ref/SHA");
    expect(withoutComputerUse).not.toContain("Computer Use execution is Root-only");

    const withComputerUse = rootDeveloperInstructions(true);
    expect(withComputerUse).toContain("MUST orchestrate and delegate every task");
    expect(withComputerUse).toContain(
      "Interactive GUI, browser, and Computer Use execution is Root-only and must not be delegated.",
    );
    expect(withComputerUse).not.toContain("Computer Use is not selected");

    const leaf = renderNativeAgent(projectNativeAgents("default")[0]!);
    expect(leaf).toContain("Surgical mutation rule:");
    expect(leaf).toContain("Do not delegate, message peers, mutate global Intent lifecycle");
    expect(leaf).toContain("`completed`, `blocked`, `needs_root_input`, or `failed`");
    expect(leaf).toContain("Every Assignment must state its exact boundary");

    for (const agent of projectNativeAgents("default")) {
      const rendered = renderNativeAgent(agent);
      if (agent.name === "Worker.operations") {
        expect(agent.permissions.networkScope).toBe("exact_ref_or_sha");
        expect(rendered).toContain('web_search = "live"');
      } else if (agent.name.startsWith("Worker.")) {
        expect(agent.permissions.network).toBe(false);
        expect(agent.permissions.networkScope).toBe("disabled");
        expect(rendered).toContain('web_search = "disabled"');
      }
    }
  });
});

describe("interactive command boundary", () => {
  test("passes flag selections through the injected wizard and shared installer path", async () => {
    const root = await mkdtemp(join(tmpdir(), "holycodex-wizard-"));
    const states = new Map<string, { installed: boolean; enabled: boolean }>();
    const manager = {
      list: async () => ({
        installed: [...states]
          .filter(([, state]) => state.installed)
          .map(([pluginId, state]) => ({ pluginId, ...state })),
        available: [...states]
          .filter(([, state]) => !state.installed)
          .map(([pluginId, state]) => ({ pluginId, ...state })),
      }),
      addMarketplace: async () => undefined,
      add: async (pluginId: string) => {
        states.set(pluginId, { installed: true, enabled: true });
      },
      remove: async (pluginId: string) => {
        states.delete(pluginId);
      },
    };
    let initial: InstallRequest | undefined;
    try {
      const result = await runCli(["install", "--profile", "low", "--work", "--no-security"], {
        io: {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          installWizard: async (request) => {
            initial = request;
            return {
              action: "install",
              request: {
                ...request,
                profile: "low",
                tier: "fast",
                optional: {
                  work: true,
                  frontend: true,
                  security: false,
                  computer_use: true,
                },
              },
            };
          },
          writeStderr: () => undefined,
          writeStdout: () => undefined,
        },
        installer: { paths: { codexHome: join(root, "codex") }, officialPluginManager: manager },
      });
      expect(initial).toEqual({
        profile: "low",
        optional: { work: true, security: false },
      });
      expect(result.exitCode).toBe(0);
      expect(result.envelope).toMatchObject({ ok: true, command: "install" });
      if (result.envelope.ok) {
        expect(result.envelope.data).toMatchObject({ record: { profile: "low", tier: "fast" } });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("returns a classified cancellation without invoking installation", async () => {
    const result = await runCli(["install"], {
      io: {
        stdoutIsTTY: true,
        stderrIsTTY: true,
        installWizard: async () => ({ action: "cancel" }),
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: { code: "install_cancelled" },
    });
  });

  test("does not enter the wizard when either output stream is non-TTY", async () => {
    const result = await runCli(["install"], {
      io: { stdoutIsTTY: true, stderrIsTTY: false },
    });
    expect(result.exitCode).toBe(1);
    expect(result.envelope).toMatchObject({
      ok: false,
      error: { code: "non_tty_confirmation_required" },
    });
  });
});
