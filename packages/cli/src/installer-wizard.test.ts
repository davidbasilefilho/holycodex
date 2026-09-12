// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAPABILITY_REGISTRY,
  FRONTEND_WORKFLOW_POLICY,
  GENERIC_BUILTIN_AGENT_TYPES,
  NATIVE_AGENT_TYPES,
} from "@holycodex/core";

import {
  parseArgv,
  parsePluginInput,
  applyWizardConfigurationKey,
  renderInstallWizardReview,
  rootDeveloperInstructions,
  projectNativeAgents,
  projectRootAgent,
  renderNativeAgent,
  windowsGitBashShellDirective,
  runCli,
  toInstallOptions,
  stateFromRequest,
  type InstallOptions,
  type InstallRequest,
} from "./index.ts";

const ANSI_SGR_PATTERN = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "gu");

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
        frontend: false,
        security: true,
        computer_use: true,
      },
      officialPlugins: ["example@marketplace"],
    });

    expect(review).toContain("Review configuration");
    expect(review).toContain("Profile: default");
    expect(review).toContain("Service tier: fast-all");
    expect(review).not.toContain("Work:");
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
      optional: { frontend: true, security: false, computer_use: false },
      officialPlugins: ["one@marketplace", "one@marketplace"],
    };
    const options = toInstallOptions({
      profile: initial.profile!,
      tier: initial.tier!,
      optional: {
        frontend: initial.optional?.frontend ?? false,
        security: initial.optional?.security ?? false,
        computer_use: initial.optional?.computer_use ?? false,
      },
      plugins: [...initial.officialPlugins!],
      pluginInput: initial.officialPlugins!.join(" "),
      pluginCursor: initial.officialPlugins!.join(" ").length,
    });
    expect(options).toEqual({
      profile: "high",
      tier: "standard",
      optional: { frontend: true, security: false, computer_use: false },
      officialPlugins: ["one@marketplace", "one@marketplace"],
    } satisfies InstallOptions);
  });

  test("applies navigation, choice, toggle, submit, and text-editing semantics", () => {
    const state = stateFromRequest({
      profile: "default",
      optional: { frontend: true, security: true, computer_use: false },
      officialPlugins: ["alpha@marketplace"],
    });
    expect(applyWizardConfigurationKey(state, 0, { name: "down" }).cursor).toBe(1);
    expect(applyWizardConfigurationKey(state, 1, { name: "left" }).cursor).toBe(1);
    expect(state.tier).toBe("fast-all");
    expect(applyWizardConfigurationKey(state, 2, { name: "space" }).cursor).toBe(2);
    expect(state.optional.frontend).toBe(false);
    expect(applyWizardConfigurationKey(state, 2, { name: "right" }).cursor).toBe(2);
    expect(state.optional.frontend).toBe(false);
    expect(applyWizardConfigurationKey(state, 2, { name: "enter" })).toEqual({
      cursor: 2,
      action: "review",
    });
    const pluginCursor = 5;
    state.pluginCursor = 5;
    expect(applyWizardConfigurationKey(state, pluginCursor, { name: "left" }).cursor).toBe(
      pluginCursor,
    );
    expect(state.pluginCursor).toBe(4);
    applyWizardConfigurationKey(state, pluginCursor, { name: "X" });
    expect(state.pluginInput).toBe("alphXa@marketplace");
    applyWizardConfigurationKey(state, pluginCursor, { name: "backspace" });
    expect(state.pluginInput).toBe("alpha@marketplace");
    expect(applyWizardConfigurationKey(state, pluginCursor, { name: "escape" }).action).toBe(
      "cancel",
    );
  });

  test("uses semantic color only for an interactive TTY", () => {
    const request: InstallRequest = { optional: { frontend: true, security: false } };
    const colored = renderInstallWizardReview(request, "install", {
      stdoutIsTTY: true,
      env: {},
    });
    expect(colored).toContain("\u001b[");
    expect(colored.replace(ANSI_SGR_PATTERN, "")).toContain("Frontend: enabled");
    expect(renderInstallWizardReview(request)).not.toContain("\u001b[");
    expect(
      renderInstallWizardReview(request, "install", {
        stdoutIsTTY: true,
        env: { NO_COLOR: "1" },
      }),
    ).not.toContain("\u001b[");
  });
});

describe("generated Root orchestration policy", () => {
  test("requires delegation while keeping Computer Use unavailable unless Root selected it", () => {
    const withoutComputerUse = rootDeveloperInstructions(false);
    expect(withoutComputerUse).toMatch(/gpt-6-astra/iu);
    expect(withoutComputerUse).toMatch(/every delegable action/iu);
    expect(withoutComputerUse).toMatch(
      /repository discovery.*source.*test.*documentation inspection/iu,
    );
    expect(withoutComputerUse).toMatch(
      /Starting the Assignment and dispatching.*must precede every such inspection or execution/isu,
    );
    expect(withoutComputerUse).toMatch(/no generic Root direct-work fallback/iu);
    expect(withoutComputerUse).not.toMatch(
      /when useful|when appropriate|for complex work|delegate where practical/iu,
    );
    expect(withoutComputerUse).toMatch(
      /Root directly owns only user interaction; Intent; material decisions; orchestration and lifecycle; integration acceptance; completion; Git\/VCS; external effects; GUI and browser execution; Computer Use when selected/iu,
    );
    expect(withoutComputerUse).not.toMatch(/interactive capabilities/iu);
    expect(withoutComputerUse).toMatch(/Computer Use is unavailable/iu);
    expect(withoutComputerUse).toMatch(/cannot be delegated/iu);
    expect(withoutComputerUse).toMatch(/GUI.*browser.*Root\/session-only/iu);
    expect(withoutComputerUse).toMatch(/routine safe, reversible, in-scope choices/iu);
    expect(withoutComputerUse).toMatch(/authorized.*read-only.*preparatory/iu);
    expect(withoutComputerUse).toMatch(/installation profile approval/iu);
    expect(withoutComputerUse).toMatch(/independent.*Assignments.*concurrently/iu);
    expect(withoutComputerUse).toMatch(/later-phase questions/iu);
    expect(withoutComputerUse).toMatch(/writing-instructions/iu);
    expect(withoutComputerUse).not.toMatch(/writing-for-agents|Luna contracts/iu);
    expect(withoutComputerUse).toMatch(/Context7.*before model memory/isu);
    expect(withoutComputerUse).toMatch(/meaningful proof appropriate/iu);
    expect(withoutComputerUse).toMatch(/source change.*failure.*material concern/isu);
    expect(withoutComputerUse).toMatch(/Frontend is selected/iu);
    for (const mapping of CAPABILITY_REGISTRY.frontend.applicability) {
      expect(withoutComputerUse).toContain(mapping.skillId);
      expect(withoutComputerUse).toContain(mapping.appliesWhen);
    }
    expect(FRONTEND_WORKFLOW_POLICY.repositoryAndUserRequirementsPrecedePluginDefaults).toBe(true);
    expect(withoutComputerUse).toMatch(
      /Repository stack, existing design system, and explicit user requirements govern over generic plugin defaults/iu,
    );
    const frontendDisabled = rootDeveloperInstructions({ frontend: false, security: false });
    for (const mapping of CAPABILITY_REGISTRY.frontend.applicability) {
      expect(frontendDisabled).not.toContain(mapping.skillId);
    }
    expect(withoutComputerUse).toMatch(/Security is selected/iu);
    expect(withoutComputerUse).toMatch(/Worker\.validation/iu);
    expect(withoutComputerUse).toMatch(/Reviewer\.code.*fixed-point/iu);
    expect(withoutComputerUse).toMatch(/exact ref or SHA/iu);
    expect(withoutComputerUse).not.toMatch(/delegate GUI.*Computer Use/iu);

    expect(withoutComputerUse).toMatch(
      /exact concrete registered Role\.task agent_type.*canonical HolyCodex inventory/isu,
    );
    expect(withoutComputerUse).toMatch(
      /normal specialist spawn.*fork_turns: "none".*never omit.*all.*default/isu,
    );
    expect(withoutComputerUse).toMatch(/configured model and reasoning effort/iu);
    expect(withoutComputerUse).toMatch(/self-contained.*task-specific semantic context/isu);
    expect(withoutComputerUse).toMatch(/only useful or important information/isu);
    expect(withoutComputerUse).toMatch(/after every tool use or subagent update/isu);
    expect(withoutComputerUse).toMatch(/routine status-only chatter.*heartbeat/isu);
    expect(withoutComputerUse).toMatch(/fixed update cadence/isu);
    expect(withoutComputerUse).toMatch(/significant findings or decisions/isu);
    expect(withoutComputerUse).toMatch(/consequential blockers or input needs/isu);
    expect(withoutComputerUse).toMatch(/release milestones/isu);
    expect(withoutComputerUse).toMatch(/native Astra Default questions.*independent work/isu);
    expect(withoutComputerUse).toMatch(/no question protocol/isu);
    expect(withoutComputerUse).toMatch(/out-of-boundary.*new bounded Assignment/isu);
    expect(withoutComputerUse).toMatch(/longest practical event wait/iu);
    expect(withoutComputerUse).toMatch(/never busy-poll.*status-only coordination loops/isu);
    expect(withoutComputerUse).toMatch(/batch independent lifecycle actions/iu);
    expect(withoutComputerUse).toMatch(/release specialist leaves/iu);
    for (const agentType of NATIVE_AGENT_TYPES) {
      expect(withoutComputerUse).toContain(agentType);
    }
    expect(withoutComputerUse).toMatch(
      /role families Explorer, Librarian, Worker, and Reviewer are labels only/iu,
    );
    expect(withoutComputerUse).toMatch(/never dispatch targets/iu);
    for (const genericAgentType of GENERIC_BUILTIN_AGENT_TYPES) {
      expect(withoutComputerUse).toContain(genericAgentType);
    }
    expect(withoutComputerUse).toMatch(/forbidden for HolyCodex specialist Assignments/iu);
    expect(withoutComputerUse).toMatch(
      /no matching concrete registered route.*needs_root_input/isu,
    );
    expect(withoutComputerUse).not.toMatch(
      /native Explorer, Librarian, Worker, or Reviewer route/iu,
    );
    expect(withoutComputerUse).not.toMatch(
      /dispatch (?:a|an)?\s*(?:Explorer|Librarian|Worker|Reviewer) route/iu,
    );

    const withComputerUse = rootDeveloperInstructions(true);
    expect(withComputerUse).toMatch(/every delegable action/iu);
    expect(withComputerUse).toMatch(/GUI and browser execution; Computer Use when selected/iu);
    expect(withComputerUse).toMatch(/Computer Use is selected.*Root\/session only/iu);
    expect(withComputerUse).toMatch(/user personally enters and submits/iu);
    expect(withComputerUse).toMatch(/default browser/iu);
    expect(withComputerUse).not.toMatch(/Computer Use is not selected/iu);

    expect(projectRootAgent("default")).toMatchObject({
      model: "gpt-6-astra",
      effort: "medium",
    });

    const leaf = renderNativeAgent(projectNativeAgents("default")[0]!);
    expect(leaf).toMatch(/GPT-6-family specialist/iu);
    expect(leaf).not.toMatch(/GPT-5\.6 Luna specialist|Luna contracts/iu);
    expect(leaf).not.toMatch(/smallest complete edit set/iu);
    expect(leaf).toMatch(/context_management = true/iu);
    expect(leaf).toMatch(/Do not delegate.*Intent lifecycle/iu);
    expect(leaf).toMatch(/completed.*blocked.*needs_root_input.*failed/isu);
    expect(leaf).toMatch(/no.*progress.*heartbeat.*intermediate evidence/isu);
    expect(leaf).toMatch(/out-of-boundary.*new bounded Assignment/isu);
    expect(leaf).toMatch(/exact boundary.*exclusions.*acceptance criteria/iu);

    for (const agent of projectNativeAgents("default")) {
      expect(agent.model).toBe("gpt-5.6-luna");
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

    const windowsExecutable = "C:\\Program Files\\Git\\bin\\bash.exe";
    const windowsRoot = rootDeveloperInstructions({
      computerUse: false,
      windowsGitBashExecutable: windowsExecutable,
    });
    const windowsLeaf = renderNativeAgent(projectNativeAgents("default")[0]!, {
      windowsGitBashExecutable: windowsExecutable,
    });
    expect(windowsRoot).toContain(windowsExecutable);
    expect(windowsRoot).toMatch(/Resolve C:\\Program Files\\Git\\bin\\bash\.exe first/iu);
    expect(windowsRoot).toMatch(/bash on PATH only if that path is unavailable/iu);
    expect(windowsRoot).toMatch(/PowerShell.*cmd\.exe.*WSL Bash.*Cygwin/isu);
    expect(windowsLeaf).toContain("On Windows, execute every shell action");
    expect(windowsLeaf).toContain(windowsExecutable.replaceAll("\\", "\\\\"));
    expect(windowsLeaf).toContain("bash on PATH only if that path is unavailable");
    expect(rootDeveloperInstructions(false)).not.toContain(windowsGitBashShellDirective("bash"));
  });
});

describe("interactive command boundary", () => {
  test("passes flag selections into the injected wizard", async () => {
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
      const result = await runCli(["install", "--profile", "low", "--frontend", "--no-security"], {
        io: {
          stdoutIsTTY: true,
          stderrIsTTY: true,
          installWizard: async (request) => {
            initial = request;
            return { action: "cancel" };
          },
          writeStderr: () => undefined,
          writeStdout: () => undefined,
        },
        installer: { paths: { codexHome: join(root, "codex") }, officialPluginManager: manager },
      });
      expect(initial).toEqual({
        profile: "low",
        optional: { frontend: true, security: false },
      });
      expect(result.exitCode).toBe(0);
      expect(result.envelope).toMatchObject({
        ok: true,
        command: "install",
        data: { cancelled: true },
      });
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
