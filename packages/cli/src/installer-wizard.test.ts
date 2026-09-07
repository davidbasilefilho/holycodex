// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseArgv,
  parsePluginInput,
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
  test("parses additional plugin IDs as trimmed whitespace-separated values", () => {
    expect(parsePluginInput("  alpha@marketplace\t beta@marketplace  alpha@marketplace ")).toEqual([
      "alpha@marketplace",
      "beta@marketplace",
    ]);
    expect(() => parsePluginInput("bad,id")).toThrow();
  });

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
    expect(review).toContain("CAPABILITIES");
    expect(review).toContain("↑/↓ choose");
    expect(
      Math.max(
        ...review
          .trimEnd()
          .split("\n")
          .map((line) => line.length),
      ),
    ).toBeLessThanOrEqual(78);
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
  test("requires delegation while keeping Computer Use unavailable unless Root selected it", () => {
    const withoutComputerUse = rootDeveloperInstructions(false);
    expect(withoutComputerUse).toMatch(/gpt-6-astra/iu);
    expect(withoutComputerUse).toMatch(/every specialist work unit/iu);
    expect(withoutComputerUse).toMatch(/repository discovery.*source inspection/iu);
    expect(withoutComputerUse).toMatch(/first action.*create and start.*Assignment/isu);
    expect(withoutComputerUse).toMatch(/before inspecting anything itself/iu);
    expect(withoutComputerUse).toMatch(/Git\/VCS.*Root-only/iu);
    expect(withoutComputerUse).toMatch(/Computer Use is unavailable/iu);
    expect(withoutComputerUse).toMatch(/cannot be delegated/iu);
    expect(withoutComputerUse).toMatch(/GUI.*browser.*Root\/session-only/iu);
    expect(withoutComputerUse).toMatch(/routine safe choices/iu);
    expect(withoutComputerUse).toMatch(/authorized.*read-only.*preparatory/iu);
    expect(withoutComputerUse).toMatch(/installation profile approval/iu);
    expect(withoutComputerUse).toMatch(/independent.*Assignments.*concurrently/iu);
    expect(withoutComputerUse).toMatch(/later-phase questions/iu);
    expect(withoutComputerUse).not.toMatch(/reload|load writing-for-agents/iu);
    expect(withoutComputerUse).toMatch(/Worker\.validation/iu);
    expect(withoutComputerUse).toMatch(/Reviewer\.code.*fixed-point/iu);
    expect(withoutComputerUse).toMatch(/exact ref or SHA/iu);
    expect(withoutComputerUse).not.toMatch(/delegate GUI.*Computer Use/iu);

    const withComputerUse = rootDeveloperInstructions(true);
    expect(withComputerUse).toMatch(/every specialist work unit/iu);
    expect(withComputerUse).toMatch(/GUI.*browser.*Root-only/iu);
    expect(withComputerUse).toMatch(/Computer Use is selected.*Root\/session only/iu);
    expect(withComputerUse).not.toMatch(/Computer Use is not selected/iu);

    const leaf = renderNativeAgent(projectNativeAgents("default")[0]!);
    expect(leaf).toMatch(/gpt-5\.6-luna/iu);
    expect(leaf).not.toMatch(/smallest complete edit set/iu);
    expect(leaf).toMatch(/context_management = true/iu);
    expect(leaf).toMatch(/Do not delegate.*Intent lifecycle/iu);
    expect(leaf).toMatch(/completed.*blocked.*needs_root_input.*failed/isu);
    expect(leaf).toMatch(/exact boundary.*exclusions.*acceptance criteria/iu);

    for (const agent of projectNativeAgents("default")) {
      const rendered = renderNativeAgent(agent);
      expect(rendered).toContain("context_management = true");
      if (agent.name === "Worker.operations") {
        expect(agent.permissions.networkScope).toBe("exact_ref_or_sha");
        expect(agent.permissions.sourceMutation).toBe(false);
        expect(agent.permissions.filesystem).toBe("read-only");
        expect(rendered).toMatch(/Do not modify repository source/iu);
        expect(rendered).toContain('web_search = "live"');
      } else if (agent.name === "Reviewer.plan") {
        expect(agent.permissions.sourceMutation).toBe(false);
        expect(agent.permissions.filesystem).toBe("read-only");
        expect(rendered).toMatch(/Do not modify repository source/iu);
      } else if (agent.name === "Worker.validation") {
        expect(agent.permissions.sourceMutation).toBe(false);
        expect(agent.permissions.filesystem).toBe("workspace-write");
        expect(rendered).toMatch(/Do not modify repository source/iu);
        expect(rendered).toContain('sandbox_mode = "workspace-write"');
      } else if (agent.name === "Worker.debugging") {
        expect(agent.permissions.network).toBe(false);
        expect(agent.permissions.sourceMutation).toBe(true);
        expect(rendered).toContain('web_search = "disabled"');
        expect(rendered).toMatch(/reproducibly.*root/isu);
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
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({
      ok: true,
      data: { cancelled: true },
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
