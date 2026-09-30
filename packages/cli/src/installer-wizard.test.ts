// SPDX-License-Identifier: Apache-2.0

import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CAPABILITY_REGISTRY, NATIVE_AGENT_TYPES } from "@holycodex/core";

import {
  parseArgv,
  parsePluginInput,
  applyWizardConfigurationKey,
  renderInstallWizardReview,
  rootDeveloperInstructions,
  projectNativeAgents,
  projectRootAgent,
  renderNativeAgent,
  runOpenTuiConflictResolver,
  runOpenTuiInstallWizard,
  readInstallationVersion,
  runCli,
  toInstallOptions,
  stateFromRequest,
  type InstallOptions,
  type InstallRequest,
  type ManagedConflict,
} from "./index.ts";
import {
  applyConflictScreenKey,
  applyInstallReviewKey,
  renderConflictScreen,
  renderInstallReview,
  runOpenTuiInstallReview,
  stateFromConflicts,
  type InstallReviewScreenState,
} from "./installer-wizard.ts";
import type { InstallReview } from "./types.ts";

const CURRENT_VERSION = await readInstallationVersion();

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
    fg:
      (color: string) =>
      (input: string | FakeChunk): FakeChunk => {
        const chunk = typeof input === "string" ? { text: input } : input;
        return { ...chunk, styles: [...(chunk.styles ?? []), color] };
      },
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
        sites: false,
        browser_use: true,
        computer_use: true,
      },
      officialPlugins: ["example@marketplace"],
    });

    expect(review).toContain("Review configuration");
    expect(review).toContain("Profile: default");
    expect(review).toContain("Service tier: fast-all");
    expect(review).not.toContain("Work:");
    expect(review).toContain("ChatGPT Sites: disabled");
    expect(review).toContain("Browser Use: enabled");
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
      optional: { sites: false, browser_use: true, computer_use: false },
      officialPlugins: ["one@marketplace", "one@marketplace"],
    };
    const options = toInstallOptions({
      profile: initial.profile!,
      tier: initial.tier!,
      optional: {
        sites: initial.optional?.sites ?? true,
        browser_use: initial.optional?.browser_use ?? true,
        computer_use: initial.optional?.computer_use ?? false,
      },
      plugins: [...initial.officialPlugins!],
      pluginInput: initial.officialPlugins!.join(" "),
      pluginCursor: initial.officialPlugins!.join(" ").length,
    });
    expect(options).toEqual({
      profile: "high",
      tier: "standard",
      optional: { sites: false, browser_use: true, computer_use: false },
      officialPlugins: ["one@marketplace", "one@marketplace"],
    } satisfies InstallOptions);
  });

  test("applies navigation, choice, toggle, submit, and text-editing semantics", () => {
    const state = stateFromRequest({
      profile: "default",
      optional: { sites: true, browser_use: true, computer_use: false },
      officialPlugins: ["alpha@marketplace"],
    });
    expect(applyWizardConfigurationKey(state, 0, { name: "down" }).cursor).toBe(1);
    expect(applyWizardConfigurationKey(state, 1, { name: "left" }).cursor).toBe(1);
    expect(state.tier).toBe("fast-all");
    expect(applyWizardConfigurationKey(state, 2, { name: "space" }).cursor).toBe(2);
    expect(state.optional.sites).toBe(false);
    expect(applyWizardConfigurationKey(state, 2, { name: "right" }).cursor).toBe(2);
    expect(state.optional.sites).toBe(false);
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
    const request: InstallRequest = { optional: { sites: true, browser_use: false } };
    const colored = renderInstallWizardReview(request, "install", {
      stdoutIsTTY: true,
      env: {},
    });
    expect(colored).toContain("\u001b[");
    expect(colored.replace(ANSI_SGR_PATTERN, "")).toContain("ChatGPT Sites: enabled");
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
      capabilities: { computer_use: true, sites: true, browser_use: true },
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
    expect(install).toContain("Context7: Use available ctx7");
    expect(install).not.toContain("Context7: ready (bunx)");
    expect(
      renderInstallReview({
        ...review,
        tools: [{ name: "Context7", status: "unavailable" }],
      }),
    ).toContain("Context7: Attempt optional managed ctx7 install");
    const colored = renderInstallReview(review, 0, { stdoutIsTTY: true, env: {} });
    expect(colored).toContain("\u001b[");
    expect(colored.replace(ANSI_SGR_PATTERN, "")).toContain("Profile: high");
    expect(
      renderInstallReview(review, 0, {
        stdoutIsTTY: true,
        env: { NO_COLOR: "1" },
      }),
    ).not.toContain("\u001b[");

    const withoutConflicts = renderInstallReview({ ...review, conflicts: [], conflictCounts: {} });
    expect(withoutConflicts).not.toContain("Resolve conflicts");
  });

  test("keeps final review navigation and Esc back distinct from cancellation", () => {
    const review: InstallReview = {
      operation: "install",
      toVersion: CURRENT_VERSION,
      profile: "default",
      tier: "standard",
      capabilities: { computer_use: false, sites: true, browser_use: false },
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
  });

  test("applies canonical native color policy and semantic styles across screens", async () => {
    const review: InstallReview = {
      operation: "install",
      toVersion: CURRENT_VERSION,
      profile: "default",
      tier: "standard",
      capabilities: {
        computer_use: false,
        sites: true,
        browser_use: false,
      },
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
      expect(styledReview.some((chunk) => chunk.styles?.includes("#9ece6a") === true)).toBe(true);
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
        runOpenTuiConflictResolver([{ ...conflict, defaultDecision: "replace" }], {
          stdoutIsTTY: true,
          env: {},
        }),
      ).resolves.toMatchObject({ action: "continue" });
      const styledConflict = fakeStyledChunks(sharedRendered[0]!);
      expect(styledConflict.some((chunk) => chunk.text === "HolyCodex · resolve conflicts")).toBe(
        true,
      );
      expect(
        styledConflict.some(
          (chunk) => chunk.text.includes("replace") && chunk.styles?.includes("#e0af68") === true,
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
      expect(fakePlainText(navigationRendered[1]!)).toContain("> replace   Worker");
      expect(fakePlainText(navigationRendered[2]!)).toContain("> replace   model");
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
        runOpenTuiConflictResolver(
          conflicts,
          { stdoutIsTTY: true, env: {} },
          Object.fromEntries(conflicts.map(({ identity }) => [identity, "replace"])),
        ),
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
          conflicts,
          { stdoutIsTTY: true, env: {} },
          Object.fromEntries(conflicts.map(({ identity }) => [identity, "keep"])),
        ),
      ).resolves.toEqual({
        action: "continue",
        decisions: Object.fromEntries(conflicts.map(({ identity }) => [identity, "replace"])),
      });
    } finally {
      mock.restore();
    }
  });

  test("defaults to the executable action and only cycles through actions that can continue", () => {
    const conflicts: ManagedConflict[] = [
      {
        identity: "invalid-provider",
        category: "configuration",
        target: "providers.local.command",
        path: "config.toml",
        action: "replace",
        existing: "missing-executable",
        desired: "bunx provider",
        explanation: "The configured executable cannot be found.",
        validDecisions: ["keep", "replace"],
        defaultDecision: "keep",
      },
      {
        identity: "conflicting-key",
        category: "configuration",
        target: "model",
        path: "config.toml",
        action: "replace",
        existing: "user-model",
        desired: "managed-model",
        validDecisions: ["keep", "cancel"],
        defaultDecision: "keep",
      },
    ];
    const state = stateFromConflicts(conflicts, { "invalid-provider": "replace" });
    expect(state.decisions).toEqual({ "invalid-provider": "replace", "conflicting-key": "keep" });

    const rendered = renderConflictScreen(conflicts, state.decisions);
    expect(rendered).toContain("providers.local.command");
    expect(rendered).toContain("> replace   providers.local.command");
    expect(rendered).not.toContain("choices:");
    expect(rendered).not.toContain("cancel     ");

    expect(applyConflictScreenKey(state, 0, { name: "right" })).toEqual({
      cursor: 0,
      action: "render",
    });
    expect(state.decisions["invalid-provider"]).toBe("keep");
    expect(applyConflictScreenKey(state, 0, { name: "left" })).toEqual({
      cursor: 0,
      action: "render",
    });
    expect(state.decisions["invalid-provider"]).toBe("replace");
  });

  test("does not expose per-item cancellation when Keep is the only executable action", () => {
    const conflict: ManagedConflict = {
      identity: "keep-or-cancel",
      category: "configuration",
      target: "model",
      path: "config.toml",
      action: "replace",
      existing: "user-model",
      desired: "managed-model",
      validDecisions: ["keep", "cancel"],
      defaultDecision: "keep",
    };

    const rendered = renderConflictScreen([conflict]);
    expect(rendered).toContain("> keep      model");
    expect(rendered).toContain("Ctrl-C cancel");
    expect(rendered).not.toContain("cancel      model");
    expect(rendered).not.toContain("Replace the current");
  });

  test("blocks a conflict with no executable action instead of offering per-item Cancel", () => {
    const conflict: ManagedConflict = {
      identity: "blocked",
      target: "marketplace",
      path: "config.toml",
      action: "replace",
      validDecisions: ["cancel"],
    };
    const state = stateFromConflicts([conflict]);
    const rendered = renderConflictScreen([conflict], state.decisions);

    expect(rendered).toContain("> blocked   marketplace");
    expect(rendered).toContain("No available action can continue this operation.");
    expect(rendered).not.toContain("cancel   marketplace");
    expect(applyConflictScreenKey(state, 0, { name: "enter" })).toEqual({
      cursor: 0,
      action: "cancel",
    });
  });

  test("uses removal-specific choices and distinguishes the live resolver Back and Cancel actions", async () => {
    const conflict: ManagedConflict = {
      identity: "remove-role",
      category: "role-asset",
      target: "Explorer.lookup",
      path: "agents/Explorer.lookup.toml",
      action: "remove",
      existing: { present: true, digest: "observed" },
      validDecisions: ["keep", "remove", "cancel"],
      defaultDecision: "keep",
    };
    const rendered: FakeContent[] = [];
    const removeRenderer = fakeRenderer([{ name: "right" }, { name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(removeRenderer, rendered));
    try {
      await expect(
        runOpenTuiConflictResolver([conflict], { stdoutIsTTY: true, env: {} }),
      ).resolves.toEqual({ action: "continue", decisions: { "remove-role": "remove" } });
      const screen = fakePlainText(rendered[0]!);
      expect(screen).toContain("> keep      Explorer.lookup");
      expect(fakePlainText(rendered[1]!)).toContain("> remove    Explorer.lookup");
      expect(fakePlainText(rendered[1]!)).toContain("install   remove this managed item");
      expect(fakePlainText(rendered[1]!)).toContain("Remove the managed item.");
      expect(screen).not.toContain("choices:");
    } finally {
      mock.restore();
    }

    const backRenderer = fakeRenderer([{ name: "escape" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(backRenderer, []));
    try {
      await expect(
        runOpenTuiConflictResolver([conflict], { stdoutIsTTY: true, env: {} }),
      ).resolves.toEqual({ action: "back" });
    } finally {
      mock.restore();
    }

    const cancelRenderer = fakeRenderer([{ name: "c", ctrl: true }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(cancelRenderer, []));
    try {
      await expect(
        runOpenTuiConflictResolver([conflict], { stdoutIsTTY: true, env: {} }),
      ).resolves.toEqual({ action: "cancel" });
    } finally {
      mock.restore();
    }

    const cancelledRemoval = await runCli(["remove"], {
      io: {
        stdoutIsTTY: true,
        stderrIsTTY: true,
        confirm: async () => "cancelled",
      },
    });
    expect(cancelledRemoval.exitCode).toBe(1);
    expect(cancelledRemoval.envelope).toMatchObject({
      ok: true,
      data: { cancelled: true },
    });
  });

  test("defaults invalid-table conflicts to Remove and explains the focused effect", async () => {
    const conflict: ManagedConflict = {
      identity: "invalid-config:features",
      category: "invalid-config",
      target: "features",
      path: "config.toml",
      key: "features",
      action: "remove",
      existing: false,
      desired: "Create the required features table.",
      validDecisions: ["remove", "cancel"],
      defaultDecision: "cancel",
    };
    const rendered: FakeContent[] = [];
    const renderer = fakeRenderer([{ name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(renderer, rendered));
    try {
      await expect(
        runOpenTuiConflictResolver([conflict], { stdoutIsTTY: true, env: {} }),
      ).resolves.toEqual({
        action: "continue",
        decisions: { "invalid-config:features": "remove" },
      });
      const screen = fakePlainText(rendered[0]!);
      expect(screen).toContain("> remove    features");
      expect(screen).toContain("install   Create the required features table.");
      expect(screen).toContain(
        "Remove the invalid value so HolyCodex can create the required table.",
      );
      expect(screen).not.toContain("HolyCodex-owned");
      expect(screen).not.toContain("managed item");
    } finally {
      mock.restore();
    }
  });

  test("bulk Replace and Keep apply only decisions that can continue", () => {
    const conflicts: ManagedConflict[] = [
      {
        identity: "normal",
        target: "model",
        path: "config.toml",
        action: "replace",
        validDecisions: ["keep", "replace", "cancel"],
      },
      {
        identity: "invalid-config",
        category: "invalid-config",
        target: "features",
        path: "config.toml",
        action: "remove",
        validDecisions: ["remove", "cancel"],
      },
    ];
    const state = stateFromConflicts(conflicts, { normal: "keep" });
    expect(state.decisions).toEqual({ normal: "keep", "invalid-config": "remove" });

    applyConflictScreenKey(state, 0, { name: "a", shift: true });
    expect(state.decisions).toEqual({ normal: "replace", "invalid-config": "remove" });
    applyConflictScreenKey(state, 0, { name: "K", shift: true });
    expect(state.decisions).toEqual({ normal: "keep", "invalid-config": "remove" });
  });

  test("renders all 15 conflicts in an aligned 80-column native and text layout", async () => {
    const conflicts: ManagedConflict[] = Array.from({ length: 15 }, (_, index) => ({
      identity: `config:${index}`,
      category: "config-key",
      target: `setting-${String(index).padStart(2, "0")}`,
      path: "config.toml",
      action: "replace",
      existing: `current-${index}`,
      desired: `install-${index}`,
    }));
    const text = renderConflictScreen(conflicts);
    const native: FakeContent[] = [];
    const renderer = fakeRenderer([{ name: "enter" }]);
    await mock.module("@opentui/core", () => fakeOpenTuiModule(renderer, native));
    try {
      await expect(
        runOpenTuiConflictResolver(conflicts, {
          width: 80,
          height: 24,
          stdoutIsTTY: false,
          env: {},
        }),
      ).resolves.toMatchObject({ action: "continue" });
    } finally {
      mock.restore();
    }

    const rendered = fakePlainText(native[0]!);
    expect(rendered).toBe(text);
    expect(rendered).toContain("15 conflicts");
    expect(rendered).toContain("↑/↓ navigate   ←/→ change action   A replace all   K keep all");
    expect(
      rendered.split("\n").filter((line) => /^[> ] replace   setting-/u.test(line)),
    ).toHaveLength(15);
    expect(rendered).toContain("current   current-0");
    expect(rendered).not.toContain("current-1");
    expect(rendered.split("\n").every((line) => line.length <= 80)).toBe(true);
    expect(rendered.split("\n").length - 1).toBe(24);
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
      capabilities: { computer_use: true, sites: true, browser_use: true },
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
        expect(plain).toContain("Context7: Use available ctx7");
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
  test("keeps delegation and Root authority explicit across profiles", () => {
    const sol = rootDeveloperInstructions({ rootModel: "gpt-6.1-sol" });
    const astra = rootDeveloperInstructions({ rootModel: "gpt-6-astra" });
    expect(astra).toBe(sol);
    expect(sol).toContain("Never perform delegable work yourself");
    expect(sol).toContain("Root owns user interaction; Intent");
    expect(sol).toContain("through bounded Assignments");
    expect(sol).toContain("registered Role.task configuration");
    expect(sol).toContain("Verify the registration once per configuration generation");
    expect(sol).toContain("Never inherit Root settings, substitute a generic route");
    expect(sol).toContain('fork_turns: "none"');
    expect(sol).toContain("Reviewer.code fixed point");
    expect(sol).toContain("current relevant validation");
    expect(sol).toContain("give the specialist only the bounded Assignment, never the capability");
    expect(sol).toContain("record the result with that invocation ID and capability");
    expect(sol).toContain("Recover an interrupted invocation only after confirming it stopped");
    expect(sol).toContain("Check existing authorization before asking again");
    expect(sol).toContain("For a blocking material user decision, Root alone uses grill-me");
    expect(sol).toContain("Before each specialist spawn, persist the bounded Assignment");
    expect(sol).toContain("record verification, acceptance, and readiness");
    expect(sol).toContain("complete only when holycodex-agent confirms every completion predicate");
    expect(sol).toContain(
      "Use holycodex-agent semantic operations for Intent and Assignment state.",
    );
    expect(sol).toContain("Do not edit TOON state.");
    expect(sol).not.toContain(
      "Your model and reasoning effort come from the selected Root profile",
    );
    expect(sol).not.toContain("Context7 states");
    for (const agentType of NATIVE_AGENT_TYPES) expect(sol).toContain(agentType);
    expect(projectRootAgent("default")).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "medium",
    });
  });

  test("selects conditional capability guidance and preserves specialist boundaries", () => {
    const root = rootDeveloperInstructions(true);
    expect(root).toContain("Root uses visual-loop");
    expect(root).toContain("use dev-server");
    expect(root).not.toContain("Root-only browser");
    expect(root).not.toContain("never request, enter, retrieve, expose, or store credentials");
    expect(root).toContain("babysit-ci");
    for (const mapping of CAPABILITY_REGISTRY.frontend.applicability) {
      expect(root).toContain(mapping.skillId);
      expect(root).toContain(mapping.appliesWhen);
    }
    const rootWithoutContextualGuidance = rootDeveloperInstructions({
      frontend: false,
      security: false,
    });
    expect(rootWithoutContextualGuidance).not.toContain(
      CAPABILITY_REGISTRY.frontend.applicability[0]!.skillId,
    );
    expect(rootWithoutContextualGuidance).not.toContain("For security-sensitive changes");
    expect(rootDeveloperInstructions({ frontend: false, security: true })).toContain(
      "For security-sensitive changes",
    );
    const leaf = renderNativeAgent(
      projectNativeAgents("default").find((agent) => agent.name === "Worker.implementation")!,
    );
    expect(leaf).toContain("bounded Assignment");
    expect(leaf).toContain("Patch quality:");
    expect(leaf).toContain("correctly, elegantly, and mergeably");
    expect(leaf).toContain("agent_message_board = false");
    expect(leaf).not.toContain("thread_tools");
    expect(leaf).toContain("multi_agent_v2 = false");
    expect(leaf).not.toContain("Your model and reasoning effort");
    const interactiveLeaf = renderNativeAgent(
      projectNativeAgents("default").find((agent) => agent.name === "Worker.implementation")!,
      { browserUse: true, computerUse: true },
    );
    expect(interactiveLeaf).toContain("Use Browser Use only for this Assignment");
    expect(interactiveLeaf).toContain("Use Computer Use only for this Assignment");
    expect(leaf).not.toContain("Use Browser Use only for this Assignment");
    expect(leaf).not.toContain("Use Computer Use only for this Assignment");
    expect(leaf).not.toContain("active_invocation_id");
    expect(leaf).not.toContain("never the capability");
    expect(leaf).toContain("Do not recover an Assignment");
    expect(leaf).toContain("mutate another Assignment's lifecycle");
    expect(leaf).toContain("Root keeps active invocation capabilities");

    for (const agent of projectNativeAgents("default")) {
      const rendered = renderNativeAgent(agent);
      expect(rendered).toContain(`sandbox_mode = ${JSON.stringify(agent.permissions.filesystem)}`);
      expect(rendered).toContain('web_search = "live"');
      if (agent.permissions.sourceMutation) {
        expect(rendered).toContain("Patch quality:");
      } else {
        expect(rendered).not.toContain("Patch quality:");
      }
    }
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
      const result = await runCli(["install", "--profile", "low", "--sites", "--no-browser-use"], {
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
        optional: { sites: true, browser_use: false },
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
