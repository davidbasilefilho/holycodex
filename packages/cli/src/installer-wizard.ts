// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
  type OptionalCapabilityName,
  type ProfileName,
  type ServiceTier,
} from "@holycodex/core";

import { colorEnabled, paintTerminal } from "./help.ts";
import { validateInstallOptions, type InstallOptions, type InstallRequest } from "./installer.ts";
import type { HumanRenderOptions } from "./types.ts";
import type { InstallWizardResult } from "./types.ts";

const PROFILE_NAMES: readonly ProfileName[] = ["low", "default", "high"];
const SERVICE_TIERS: readonly ServiceTier[] = ["standard", "fast", "fast-all"];
const CAPABILITY_NAMES: readonly OptionalCapabilityName[] = [
  "frontend",
  "security",
  "computer_use",
];

export type WizardState = {
  profile: ProfileName;
  tier: ServiceTier;
  optional: Record<OptionalCapabilityName, boolean>;
  plugins: string[];
  pluginInput: string;
  pluginCursor: number;
};

export type WizardKey = Readonly<{
  name: string;
  ctrl?: boolean;
  meta?: boolean;
}>;

export type WizardConfigurationTransition = Readonly<{
  cursor: number;
  action: "render" | "review" | "cancel";
}>;

/** Streams used by the OpenTUI renderer, primarily for embedded interactive callers. */
export type OpenTuiInstallWizardOptions = Readonly<{
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
}>;

/**
 * Run the public interactive install wizard using OpenTUI's imperative API.
 *
 * The OpenTUI module is loaded only after the caller has established that this is a real
 * interactive install. This keeps JSON, CI, and injected test paths independent of native terminal
 * initialization.
 */
export async function runOpenTuiInstallWizard(
  initial: InstallRequest = {},
  rendererOptions: OpenTuiInstallWizardOptions = {},
): Promise<InstallWizardResult> {
  const validatedInitial = validateInstallOptions(initial);
  const opentui = await import("@opentui/core");
  const state = stateFromRequest(validatedInitial);
  const renderer = await opentui.createCliRenderer({
    ...rendererOptions,
    exitOnCtrlC: true,
    clearOnShutdown: true,
  });
  // OpenTUI treats string content as literal text, so terminal SGR escapes render visibly.
  const color = false;
  const text = new opentui.TextRenderable(renderer, { content: renderWizard(state, 0, color) });
  renderer.root.add(text);

  return await new Promise<InstallWizardResult>((resolve, reject) => {
    let cursor = 0;
    let reviewing = false;
    let reviewChoice = 0;
    let settled = false;

    const settle = (result: InstallWizardResult): void => {
      if (settled) return;
      settled = true;
      renderer.keyInput.off("keypress", onKey);
      renderer.destroy();
      resolve(result);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      renderer.keyInput.off("keypress", onKey);
      renderer.destroy();
      reject(error);
    };

    const refresh = (): void => {
      text.content = reviewing
        ? renderReview(state, reviewChoice, color)
        : renderWizard(state, cursor, color);
      renderer.requestRender();
    };

    const onKey = (key: WizardKey): void => {
      try {
        const name = key.name.toLowerCase();
        if (key.ctrl === true && name === "c") {
          settle({ action: "cancel" });
          return;
        }
        if (reviewing) {
          if (name === "escape") {
            reviewing = false;
            refresh();
            return;
          }
          if (name === "up" || name === "k") reviewChoice = (reviewChoice + 2) % 3;
          else if (name === "down" || name === "j") reviewChoice = (reviewChoice + 1) % 3;
          else if (name === "return" || name === "enter" || name === "linefeed") {
            if (reviewChoice === 0) {
              settle({ action: "install", request: toInstallOptions(state) });
            } else if (reviewChoice === 1) {
              reviewing = false;
              cursor = 0;
            } else {
              settle({ action: "cancel" });
            }
            return;
          }
          refresh();
          return;
        }

        const transition = applyWizardConfigurationKey(state, cursor, key);
        cursor = transition.cursor;
        if (transition.action === "cancel") {
          settle({ action: "cancel" });
          return;
        }
        if (transition.action === "review") {
          reviewing = true;
          reviewChoice = 0;
        }
        refresh();
      } catch (error: unknown) {
        fail(error);
      }
    };

    renderer.keyInput.on("keypress", onKey);
    try {
      renderer.start();
    } catch (error: unknown) {
      fail(error);
    }
  });
}

/** Apply one configuration-screen key using the shared install TUI keyboard contract. */
export function applyWizardConfigurationKey(
  state: WizardState,
  cursor: number,
  key: WizardKey,
): WizardConfigurationTransition {
  const name = key.name.toLowerCase();
  const pluginField = CAPABILITY_NAMES.length + 2;
  if (name === "escape" || (key.ctrl === true && name === "c")) {
    return { cursor, action: "cancel" };
  }
  if (name === "up" || name === "k") return { cursor: Math.max(0, cursor - 1), action: "render" };
  if (name === "down" || name === "j") {
    return { cursor: Math.min(pluginField, cursor + 1), action: "render" };
  }
  if (name === "return" || name === "enter" || name === "linefeed") {
    state.plugins = parsePluginInput(state.pluginInput);
    return { cursor, action: "review" };
  }
  if (cursor === pluginField) {
    if (name === "backspace") deletePluginCharacter(state, -1);
    else if (name === "delete") deletePluginCharacter(state, 1);
    else if (name === "left") state.pluginCursor = Math.max(0, state.pluginCursor - 1);
    else if (name === "right") {
      state.pluginCursor = Math.min(state.pluginInput.length, state.pluginCursor + 1);
    } else if (name === "home") state.pluginCursor = 0;
    else if (name === "end") state.pluginCursor = state.pluginInput.length;
    else if (name === "space") insertPluginText(state, " ");
    else if (!key.ctrl && !key.meta && key.name.length === 1 && !isControlCharacter(key.name)) {
      insertPluginText(state, key.name);
    }
    return { cursor, action: "render" };
  }
  if (name === "space" && cursor >= 2) toggleCapability(state, cursor - 2);
  else if (name === "left") cycleSelection(state, cursor, -1);
  else if (name === "right") cycleSelection(state, cursor, 1);
  return { cursor, action: "render" };
}

/** Create the complete validated install options represented by wizard state. */
export function toInstallOptions(state: Readonly<WizardState>): InstallOptions {
  const request: InstallRequest =
    state.plugins.length > 0
      ? {
          profile: state.profile,
          tier: state.tier,
          optional: { ...state.optional },
          officialPlugins: [...state.plugins],
        }
      : { profile: state.profile, tier: state.tier, optional: { ...state.optional } };
  return validateInstallOptions(request);
}

/** Render the final semantic configuration review for the public wizard. */
export function renderInstallWizardReview(
  request: InstallRequest,
  selectedAction: "install" | "change" | "cancel" = "install",
  options: HumanRenderOptions = {},
): string {
  const state = stateFromRequest(validateInstallOptions(request));
  return renderReview(
    state,
    selectedAction === "install" ? 0 : selectedAction === "change" ? 1 : 2,
    colorEnabled({ ...options, stream: "stdout" }),
  );
}

/** Build editable wizard state from the validated install boundary. */
export function stateFromRequest(request: InstallRequest): WizardState {
  const optional = {
    ...DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
    ...request.optional,
  };
  return {
    profile: request.profile ?? "default",
    tier: request.tier ?? "standard",
    optional: {
      computer_use: optional.computer_use ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.computer_use,
      frontend: optional.frontend ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.frontend,
      security: optional.security ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.security,
    },
    plugins: [...(request.officialPlugins ?? [])],
    pluginInput: (request.officialPlugins ?? []).join(" "),
    pluginCursor: (request.officialPlugins ?? []).join(" ").length,
  };
}

function cycleSelection(state: WizardState, cursor: number, direction: -1 | 1): void {
  if (cursor === 0) {
    state.profile = cycle(PROFILE_NAMES, state.profile, direction);
  } else if (cursor === 1) {
    state.tier = cycle(SERVICE_TIERS, state.tier, direction);
  }
}

function toggleCapability(state: WizardState, index: number): void {
  const name = CAPABILITY_NAMES[index];
  if (name !== undefined) state.optional[name] = !state.optional[name];
}

function insertPluginText(state: WizardState, value: string): void {
  state.pluginInput = `${state.pluginInput.slice(0, state.pluginCursor)}${value}${state.pluginInput.slice(state.pluginCursor)}`;
  state.pluginCursor += value.length;
}

function deletePluginCharacter(state: WizardState, direction: -1 | 1): void {
  if (direction === -1) {
    if (state.pluginCursor === 0) return;
    state.pluginInput = `${state.pluginInput.slice(0, state.pluginCursor - 1)}${state.pluginInput.slice(state.pluginCursor)}`;
    state.pluginCursor -= 1;
    return;
  }
  if (state.pluginCursor >= state.pluginInput.length) return;
  state.pluginInput = `${state.pluginInput.slice(0, state.pluginCursor)}${state.pluginInput.slice(state.pluginCursor + 1)}`;
}

function cycle<T extends string>(values: readonly T[], current: T, direction: -1 | 1): T {
  const index = values.indexOf(current);
  return values[(index + direction + values.length) % values.length] ?? values[0]!;
}

/** Parse and validate whitespace-separated additional plugin identifiers. */
export function parsePluginInput(input: string): string[] {
  const plugins = [
    ...new Set(
      input
        .split(/\s+/u)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (plugins.length === 0) return [];
  // Keep the wizard's parser aligned with the shared domain boundary. This catches malformed
  // identifiers before the review screen while preserving the CLI's repeatable flag semantics.
  validateInstallOptions({ officialPlugins: plugins });
  return plugins;
}

function renderWizard(state: Readonly<WizardState>, cursor: number, color: boolean): string {
  const focused =
    cursor < 2
      ? cursor === 0
        ? "Choose the routing profile for the Root session."
        : "Choose how quickly services handle work."
      : cursor < CAPABILITY_NAMES.length + 2
        ? capabilityDescription(CAPABILITY_NAMES[cursor - 2]!)
        : "Optional plugin IDs separated by spaces. Enter continues to review.";
  const lines = [
    paintTerminal("HolyCodex  ·  install", "heading", color),
    paintTerminal(
      "↑/↓ focus   ←/→ change choice   Space toggle   Enter review   Esc cancel",
      "hint",
      color,
    ),
    "",
    paintTerminal("PROFILE", "heading", color),
    renderWizardChoice("Profile", state.profile, cursor === 0, color),
    renderWizardChoice("Service tier", state.tier, cursor === 1, color),
    "",
    paintTerminal("OPTIONAL CAPABILITIES", "heading", color),
    ...CAPABILITY_NAMES.map((name, index) =>
      renderWizardCapability(name, state.optional[name], cursor === index + 2, color),
    ),
    "",
    paintTerminal("ADDITIONAL PLUGINS", "heading", color),
    ...wrapWizardLine(
      `${cursor === CAPABILITY_NAMES.length + 2 ? "❯" : " "} ${state.pluginInput || "(none)"}`,
    ),
    "",
    paintTerminal(focused, "hint", color),
  ];
  return `${lines.join("\n")}\n`;
}

function renderWizardChoice(
  label: string,
  value: string,
  focused: boolean,
  color: boolean,
): string {
  const line = `${focused ? "❯" : " "} ${label.padEnd(13)} ${value}`;
  return paintTerminal(line, focused ? "focus" : "argument", color);
}

function renderWizardCapability(
  name: OptionalCapabilityName,
  value: boolean,
  focused: boolean,
  color: boolean,
): string {
  const marker = value ? "[x] enabled" : "[ ] disabled";
  const line = `${focused ? "❯" : " "} ${capabilityLabel(name).padEnd(14)} ${marker}`;
  return paintTerminal(line, focused ? "focus" : value ? "enabled" : "disabled", color);
}

function renderReview(state: Readonly<WizardState>, selected: number, color = false): string {
  const actions = ["Install", "Change options / Redo", "Cancel"];
  const lines = [
    paintTerminal("HolyCodex  ·  review", "heading", color),
    paintTerminal("Review configuration", "heading", color),
    paintTerminal("↑/↓ choose   Enter confirm   Esc back", "hint", color),
    "",
    `Profile: ${state.profile}`,
    `Service tier: ${state.tier}`,
    "",
    paintTerminal("CAPABILITIES", "heading", color),
    ...CAPABILITY_NAMES.map(
      (name) =>
        `  ${capabilityLabel(name)}: ${paintTerminal(enabled(state.optional[name]), state.optional[name] ? "enabled" : "disabled", color)}`,
    ),
    ...wrapWizardLine(
      `  Additional plugins: ${state.plugins.length === 0 ? "none" : state.plugins.join(" ")}`,
    ),
    "",
    ...actions.map((action, index) =>
      paintTerminal(
        `${index === selected ? "›" : " "} ${action}`,
        index === selected ? "focus" : index === 0 ? "success" : index === 1 ? "warning" : "error",
        color,
      ),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function capabilityDescription(name: OptionalCapabilityName): string {
  switch (name) {
    case "frontend":
      return "Frontend tools for building and testing web experiences.";
    case "security":
      return "Security review and vulnerability analysis tools.";
    case "computer_use":
      return "Computer Use tools for interactive GUI and browser tasks.";
  }
}

function wrapWizardLine(line: string, width = 76): string[] {
  if (line.length <= width) return [line];
  const lines: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    const split = remaining.lastIndexOf(" ", width);
    const boundary = split > 0 ? split : width;
    lines.push(remaining.slice(0, boundary));
    remaining = remaining.slice(split > 0 ? boundary + 1 : boundary);
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines;
}

function capabilityLabel(name: OptionalCapabilityName): string {
  return name === "computer_use" ? "Computer Use" : `${name[0]!.toUpperCase()}${name.slice(1)}`;
}

function enabled(value: boolean): string {
  return value ? "enabled" : "disabled";
}

function isControlCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint === 127;
}
