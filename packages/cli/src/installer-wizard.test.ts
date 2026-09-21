// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test } from "bun:test";
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
  applyInstallReviewKey,
  applyWizardConfigurationKey,
  renderInstallReview,
  renderInstallWizardReview,
  rootDeveloperInstructions,
  projectNativeAgents,
  projectRootAgent,
  renderNativeAgent,
  runOpenTuiConflictResolver,
  runOpenTuiInstallReview,
  runOpenTuiInstallWizard,
  runOpenTuiUpgradeChoiceScreen,
  readInstallationVersion,
  windowsGitBashShellDirective,
  runCli,
  toInstallOptions,
  stateFromRequest,
  type InstallOptions,
  type InstallReview,
  type InstallReviewScreenState,
  type InstallRequest,
  type ManagedConflict,
} from "./index.ts";

const CURRENT_VERSION = await readInstallationVersion();
const [CURRENT_MAJOR, CURRENT_MINOR, CURRENT_PATCH] = CURRENT_VERSION.split("-", 1)[0]!.split(".");
const PREVIOUS_VERSION = `${CURRENT_MAJOR}.${CURRENT_MINOR}.${Number(CURRENT_PATCH) - 1}`;

const ANSI_SGR_PATTERN = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "gu");

type FakeChunk = Readonly<{ text: string; styles?: readonly string[] }>;
class FakeStyledText {
  readonly chunks: readonly FakeChunk[];

  constructor(chunks: readonly FakeChunk[]) {
    this.chunks = chunks;
  }
}

type FakeContent = string | FakeStyledText;

function fakePlainText(content: FakeContent): string {
  return typeof content === "string" ? content : content.chunks.map((chunk) => chunk.text).join("");
}

function fakeStyledChunks(content: FakeContent): readonly FakeChunk[] {
  return typeof content === "string"
    ? []
    : content.chunks.filter((chunk) => chunk.styles !== undefined);
}

function fakeRenderer(
  keys: readonly { readonly name: string; readonly ctrl?: boolean; readonly shift?: boolean }[],
): {
  readonly root: { readonly add: (_value: unknown) => void };
  readonly keyInput: {
    readonly on: (
      _event: string,
      listener: (key: {
        readonly name: string;
        readonly ctrl?: boolean;
        readonly shift?: boolean;
      }) => void,
    ) => void;
    readonly off: () => void;
  };
  readonly requestRender: () => void;
  readonly start: () => void;
  readonly destroy: () => void;
} {
  let keypress:
    | ((key: { readonly name: string; readonly ctrl?: boolean; readonly shift?: boolean }) => void)
    | undefined;
  return {
    root: { add: (_value: unknown): void => undefined },
    keyInput: {
      on: (_event, listener): void => {
        keypress = listener;
      },
      off: (): void => {
        keypress = undefined;
      },
    },
    requestRender: (): void => undefined,
    start: (): void => {
      for (const key of keys) keypress?.(key);
    },
    destroy: (): void => undefined,
  };
}

function fakeOpenTuiModule(
  renderer: ReturnType<typeof fakeRenderer>,
  rendered: FakeContent[],
): Record<string, unknown> {
  const style =
    (name: string) =>
    (input: string | FakeChunk): FakeChunk => {
      const chunk = typeof input === "string" ? { text: input } : input;
      return { ...chunk, styles: [...(chunk.styles ?? []), name] };
    };
  class FakeTextRenderable {
    private value: FakeContent;

    constructor(_renderer: unknown, options: { readonly content: FakeContent }) {
      this.value = options.content;
      rendered.push(options.content);
    }

    get content(): FakeContent {
      return this.value;
    }

    set content(value: FakeContent) {
      this.value = value;
      rendered.push(value);
    }
  }
  return {
    createCliRenderer: async (): Promise<ReturnType<typeof fakeRenderer>> => renderer,
    TextRenderable: FakeTextRenderable,
    StyledText: FakeStyledText,
    stringToStyledText: (text: string): FakeStyledText => new FakeStyledText([{ text }]),
    bold: style("bold"),
    cyan: style("cyan"),
    dim: style("dim"),
    green: style("green"),
    red: style("red"),
    yellow: style("yellow"),
  };
}

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

  test("renders operation actions and only offers conflict resolution when needed", () => {
    const review: InstallReview = {
      operation: "install",
      toVersion: CURRENT_VERSION,
      profile: "high",
      tier: "fast-all",
      capabilities: { computer_use: true, frontend: false, security: true },
      additionalPlugins: ["example@marketplace"],
      conflicts: [
        {
          identity: "config:model",
          category: "config-key",
          target: "model",
          path: "config.toml",
          key: "model",
          action: "replace",
          defaultDecision: "keep",
          decision: "replace",
          validDecisions: ["keep", "replace"],
        },
        {
          identity: "role:Worker",
          category: "role-asset",
          target: "Worker",
          path: "Worker.implementation.toml",
          action: "replace",
          defaultDecision: "replace",
          decision: "keep",
          validDecisions: ["keep", "replace"],
        },
      ],
      conflictCounts: { "config-key": 1, "role-asset": 1 },
      tools: [{ name: "Context7", status: "ready", detail: "bunx" }],
    };
    const install = renderInstallReview(review);
    expect(install).toContain("HolyCodex · install review");
    expect(install).toContain("Install");
    expect(install).toContain("Resolve conflicts");
    expect(install).toContain("Config Key: 1");
    expect(install).toContain("Role Asset: 1");
    expect(install).toContain("DECISIONS (2)");
    expect(install).toContain("Keep: 1");
    expect(install).toContain("Replace: 1");
    expect(install).toContain("Context7: Install/update managed Bun copy");
    expect(install).not.toContain("Context7: ready (bunx)");
    const colored = renderInstallReview(review, 0, { stdoutIsTTY: true, env: {} });
    expect(colored).toContain("\u001b[");
    expect(colored.replace(ANSI_SGR_PATTERN, "")).toContain("Profile: high");
    expect(
      renderInstallReview(review, 0, {
        stdoutIsTTY: true,
        env: { NO_COLOR: "1" },
      }),
    ).not.toContain("\u001b[");

    const upgrade = renderInstallReview({
      ...review,
      operation: "upgrade",
      fromVersion: PREVIOUS_VERSION,
    });
    expect(upgrade).toContain("HolyCodex · upgrade review");
    expect(upgrade).toContain("Upgrade");
    expect(upgrade).not.toContain("Apply");

    const withoutConflicts = renderInstallReview({ ...review, conflicts: [], conflictCounts: {} });
    expect(withoutConflicts).not.toContain("Resolve conflicts");
  });

  test("keeps final review navigation and Esc back distinct from cancellation", () => {
    const review: InstallReview = {
      operation: "upgrade",
      fromVersion: PREVIOUS_VERSION,
      toVersion: CURRENT_VERSION,
      profile: "default",
      tier: "standard",
      capabilities: { computer_use: false, frontend: true, security: false },
      additionalPlugins: [],
      conflicts: [{ identity: "managed", path: "managed.json", action: "replace" }],
      conflictCounts: { "managed-state": 1 },
      tools: [],
    };
    const state: InstallReviewScreenState = { review, selected: 0 };
    expect(applyInstallReviewKey(state, { name: "down" })).toEqual({
      selected: 1,
      action: "render",
    });
    expect(applyInstallReviewKey({ ...state, selected: 1 }, { name: "down" })).toEqual({
      selected: 2,
      action: "render",
    });
    expect(applyInstallReviewKey({ ...state, selected: 2 }, { name: "enter" })).toEqual({
      selected: 2,
      action: "choose",
    });
    expect(applyInstallReviewKey({ ...state, selected: 0 }, { name: "up" })).toEqual({
      selected: 3,
      action: "render",
    });
    expect(applyInstallReviewKey(state, { name: "escape" })).toEqual({
      selected: 0,
      action: "back",
    });
    expect(applyInstallReviewKey(state, { name: "c", ctrl: true })).toEqual({
      selected: 0,
      action: "cancel",
    });
  });

  test("keeps native OpenTUI content semantic and free of terminal escape sequences", async () => {
    const rendered: FakeContent[] = [];
    const renderer = fakeRenderer([{ name: "enter" }, { name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(renderer, rendered));
    try {
      await expect(
        runOpenTuiInstallWizard({}, { stdoutIsTTY: false, env: {} }),
      ).resolves.toMatchObject({ action: "install" });
      expect(rendered).toHaveLength(2);
      expect(fakePlainText(rendered[0]!)).toContain("HolyCodex  ·  install");
      expect(fakePlainText(rendered[1]!)).toContain("Review configuration");
      expect(rendered.every((screen) => screen instanceof FakeStyledText)).toBe(true);
      expect(rendered.every((screen) => fakeStyledChunks(screen).length === 0)).toBe(true);
      expect(
        rendered.every((screen) => !fakePlainText(screen).includes(String.fromCodePoint(0x1b))),
      ).toBe(true);
    } finally {
      mock.restore();
    }

    const upgradeRendered: FakeContent[] = [];
    const upgradeRenderer = fakeRenderer([{ name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(upgradeRenderer, upgradeRendered));
    try {
      await expect(
        runOpenTuiUpgradeChoiceScreen(
          { profile: "default", tier: "standard", optional: { frontend: true } },
          PREVIOUS_VERSION,
          CURRENT_VERSION,
          { stdoutIsTTY: true, env: {} },
        ),
      ).resolves.toEqual({ action: "keep" });
      const styledUpgrade = fakeStyledChunks(upgradeRendered[0]!);
      expect(styledUpgrade.some((chunk) => chunk.text === "HolyCodex  ·  upgrade")).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("applies canonical native color policy and semantic styles across screens", async () => {
    const review: InstallReview = {
      operation: "install",
      toVersion: CURRENT_VERSION,
      profile: "default",
      tier: "standard",
      capabilities: { computer_use: false, frontend: true, security: false },
      additionalPlugins: [],
      conflicts: [],
      conflictCounts: {},
      tools: [],
    };
    const conflict: ManagedConflict = {
      identity: "managed",
      category: "managed-state",
      path: "managed.json",
      action: "replace",
      existing: "old",
      desired: "new",
    };
    const rendered: FakeContent[] = [];
    const renderer = fakeRenderer([{ name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(renderer, rendered));
    try {
      await expect(
        runOpenTuiInstallReview(review, { stdoutIsTTY: true, env: {} }),
      ).resolves.toEqual({ action: "apply" });
      const styledReview = fakeStyledChunks(rendered[0]!);
      expect(styledReview.some((chunk) => chunk.text === "HolyCodex · install review")).toBe(true);
      expect(
        styledReview.some(
          (chunk) => chunk.text === "enabled" && chunk.styles?.includes("green") === true,
        ),
      ).toBe(true);
    } finally {
      mock.restore();
    }

    const monoRendered: FakeContent[] = [];
    const monoRenderer = fakeRenderer([{ name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(monoRenderer, monoRendered));
    try {
      await expect(
        runOpenTuiInstallReview(review, {
          stdoutIsTTY: true,
          env: { NO_COLOR: "1", FORCE_COLOR: "1" },
        }),
      ).resolves.toEqual({ action: "apply" });
      expect(monoRendered.every((screen) => fakeStyledChunks(screen).length === 0)).toBe(true);
    } finally {
      mock.restore();
    }

    const sharedRendered: FakeContent[] = [];
    const sharedRenderer = fakeRenderer([{ name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(sharedRenderer, sharedRendered));
    try {
      await expect(
        runOpenTuiConflictResolver([conflict], { stdoutIsTTY: true, env: {} }),
      ).resolves.toMatchObject({ action: "continue" });
      const styledConflict = fakeStyledChunks(sharedRendered[0]!);
      expect(styledConflict.some((chunk) => chunk.text === "HolyCodex · resolve conflicts")).toBe(
        true,
      );
      expect(
        styledConflict.some(
          (chunk) => chunk.text === "replace" && chunk.styles?.includes("yellow") === true,
        ),
      ).toBe(true);
    } finally {
      mock.restore();
    }
  });

  test("handles normalized shifted conflict decisions while lowercase k navigates", async () => {
    const conflicts: ManagedConflict[] = [
      {
        identity: "config:model",
        category: "config-key",
        target: "model",
        path: "config.toml",
        action: "replace",
        existing: "old-model",
        desired: "new-model",
      },
      {
        identity: "role:Worker",
        category: "role-asset",
        target: "Worker",
        path: "Worker.implementation.toml",
        action: "replace",
        existing: "old-worker",
        desired: "new-worker",
      },
      {
        identity: "managed:state",
        category: "managed-state",
        target: "managed.json",
        path: "managed.json",
        action: "replace",
        existing: "old-state",
        desired: "new-state",
      },
      {
        identity: "config:cache",
        category: "config-key",
        target: "cache",
        path: "config.toml",
        action: "replace",
        existing: "old-cache",
        desired: "new-cache",
      },
      {
        identity: "role:Reviewer",
        category: "role-asset",
        target: "Reviewer",
        path: "Reviewer.implementation.toml",
        action: "replace",
        existing: "old-reviewer",
        desired: "new-reviewer",
      },
      {
        identity: "managed:lock",
        category: "managed-state",
        target: "managed.lock",
        path: "managed.lock",
        action: "replace",
        existing: "old-lock",
        desired: "new-lock",
        explanation: "The managed lock is regenerated during install.",
      },
    ];
    const defaults = Object.fromEntries(conflicts.map(({ identity }) => [identity, "replace"]));

    const navigationRendered: FakeContent[] = [];
    const navigationRenderer = fakeRenderer([{ name: "down" }, { name: "k" }, { name: "enter" }]);
    await mock.module("@opentui/core", () =>
      fakeOpenTuiModule(navigationRenderer, navigationRendered),
    );
    try {
      await expect(
        runOpenTuiConflictResolver(conflicts, { stdoutIsTTY: true, env: {} }),
      ).resolves.toEqual({ action: "continue", decisions: defaults });
      expect(fakePlainText(navigationRendered[1]!)).toContain("Focused conflict: Worker");
      expect(fakePlainText(navigationRendered[2]!)).toContain("Focused conflict: model");
      expect(
        navigationRendered.every((screen) => fakePlainText(screen).split("\n").length - 1 <= 24),
      ).toBe(true);
    } finally {
      mock.restore();
    }

    const keepRendered: FakeContent[] = [];
    const keepRenderer = fakeRenderer([{ name: "k", shift: true }, { name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(keepRenderer, keepRendered));
    try {
      await expect(
        runOpenTuiConflictResolver(conflicts, { stdoutIsTTY: true, env: {} }),
      ).resolves.toEqual({
        action: "continue",
        decisions: Object.fromEntries(conflicts.map(({ identity }) => [identity, "keep"])),
      });
    } finally {
      mock.restore();
    }

    const replaceRendered: FakeContent[] = [];
    const replaceRenderer = fakeRenderer([{ name: "a", shift: true }, { name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(replaceRenderer, replaceRendered));
    try {
      await expect(
        runOpenTuiConflictResolver(
          conflicts.map((conflict) => ({ ...conflict, defaultDecision: "keep" })),
          { stdoutIsTTY: true, env: {} },
        ),
      ).resolves.toEqual({
        action: "continue",
        decisions: Object.fromEntries(conflicts.map(({ identity }) => [identity, "replace"])),
      });
    } finally {
      mock.restore();
    }
  });

  test("keeps final native review controls visible at 80 columns by 24 rows", async () => {
    const rendered: FakeContent[] = [];
    const renderer = fakeRenderer([
      { name: "down" },
      { name: "down" },
      { name: "down" },
      { name: "enter" },
    ]);
    const review: InstallReview = {
      operation: "install",
      toVersion: CURRENT_VERSION,
      profile: "high",
      tier: "fast-all",
      capabilities: { computer_use: true, frontend: true, security: true },
      additionalPlugins: ["example@marketplace"],
      conflicts: [
        { identity: "config", category: "config-key", path: "config.toml", action: "replace" },
      ],
      conflictCounts: { "config-key": 1 },
      tools: [{ name: "Context7", status: "ready" }],
    };
    await mock.module("@opentui/core", () => fakeOpenTuiModule(renderer, rendered));
    try {
      await expect(
        runOpenTuiInstallReview(review, {
          width: 80,
          height: 24,
          stdoutIsTTY: false,
          env: {},
        }),
      ).resolves.toEqual({ action: "cancel" });
      expect(rendered.length).toBe(4);
      for (const screen of rendered) {
        const plain = fakePlainText(screen);
        expect(plain.split("\n").length - 1).toBeLessThanOrEqual(24);
        expect(plain).toContain("Review the complete preflight plan");
        expect(plain).toContain("↑/↓ or j/k choose");
        expect(plain).toContain("Resolve conflicts");
      }
    } finally {
      mock.restore();
    }
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
    expect(withoutComputerUse).toMatch(
      /collaboration\.wait_agent.*timeout_ms=3600000.*active V1 runtime maximum/isu,
    );
    expect(withoutComputerUse).toMatch(/early specialist completion wakes.*collective mailbox/isu);
    expect(withoutComputerUse).toMatch(/maximum wait expires.*same maximum wait again/isu);
    expect(withoutComputerUse).toMatch(/short waits.*list or status polling.*message loops/isu);
    expect(withoutComputerUse).toMatch(/never busy-poll.*status-only coordination loops/isu);
    expect(withoutComputerUse).toMatch(/batch independent lifecycle actions/iu);
    expect(withoutComputerUse).toMatch(/release specialist leaves/iu);
    expect(withoutComputerUse).toMatch(/concise, structured, and evidence-first/iu);
    expect(withoutComputerUse).toMatch(
      /large transcripts or artifacts only for material decisions/iu,
    );
    expect(withoutComputerUse).toMatch(/reuse stable facts.*do not duplicate policy/isu);
    expect(withoutComputerUse).toMatch(/stable bounded component scopes are canonical/iu);
    expect(withoutComputerUse).toMatch(
      /lifecycle worker owns deterministic Intent.*Assignment API/isu,
    );
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
    expect(leaf).toContain(
      "Batch independent evidence acquisition, reuse stable evidence, and avoid inspect→reason→inspect micro-loops.",
    );

    for (const agent of projectNativeAgents("default")) {
      expect(agent.model).toBe("gpt-5.6-luna");
      const rendered = renderNativeAgent(agent);
      expect(rendered).toContain("context_management = true");
      if (agent.name === "Reviewer.code") {
        expect(rendered).toContain(
          "Use one batched evidence sweep, reason over it, make targeted follow-ups only, and batch related repairs and verification.",
        );
      }
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
    const windowsDirective = windowsGitBashShellDirective(windowsExecutable);
    expect(windowsRoot).toContain(windowsExecutable);
    expect(windowsRoot).toContain(windowsDirective);
    expect(windowsLeaf).toContain(windowsDirective.replaceAll("\\", "\\\\"));
    expect(windowsGitBashShellDirective("another-bash.exe")).toBe(windowsDirective);
    expect(rootDeveloperInstructions(false)).not.toContain(windowsDirective);
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
