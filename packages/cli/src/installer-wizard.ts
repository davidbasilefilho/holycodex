// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
  type OptionalCapabilityName,
  type ProfileName,
  type ServiceTier,
} from "@holycodex/core";

import { validateInstallOptions, type InstallOptions, type InstallRequest } from "./installer.ts";
import type { InstallWizardResult } from "./types.ts";

const PROFILE_NAMES: readonly ProfileName[] = ["low", "default", "high"];
const SERVICE_TIERS: readonly ServiceTier[] = ["standard", "fast", "fast-all"];
const CAPABILITY_NAMES: readonly OptionalCapabilityName[] = [
  "work",
  "frontend",
  "security",
  "computer_use",
];

type WizardState = {
  profile: ProfileName;
  tier: ServiceTier;
  optional: Record<OptionalCapabilityName, boolean>;
  plugins: string[];
  pluginInput: string;
};

/**
 * Run the public interactive install wizard using OpenTUI's imperative API.
 *
 * The OpenTUI module is loaded only after the caller has established that this is a real
 * interactive install. This keeps JSON, CI, and injected test paths independent of native terminal
 * initialization.
 */
export async function runOpenTuiInstallWizard(
  initial: InstallRequest = {},
): Promise<InstallWizardResult> {
  const validatedInitial = validateInstallOptions(initial);
  const opentui = await import("@opentui/core");
  const state = stateFromRequest(validatedInitial);
  const renderer = await opentui.createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
  });
  const text = new opentui.TextRenderable(renderer, { content: renderWizard(state, 0) });
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
      text.content = reviewing ? renderReview(state, reviewChoice) : renderWizard(state, cursor);
      renderer.requestRender();
    };

    const onKey = (key: {
      readonly name: string;
      readonly ctrl?: boolean;
      readonly meta?: boolean;
    }): void => {
      try {
        const name = key.name.toLowerCase();
        if (name === "escape" || (key.ctrl === true && name === "c")) {
          settle({ action: "cancel" });
          return;
        }
        if (reviewing) {
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

        if (cursor === CAPABILITY_NAMES.length + 2) {
          if (name === "backspace") state.pluginInput = state.pluginInput.slice(0, -1);
          else if (name === "space") state.pluginInput += " ";
          else if (name === "return" || name === "enter" || name === "linefeed") {
            state.plugins = parsePluginInput(state.pluginInput);
            reviewing = true;
            reviewChoice = 0;
          } else if (
            !key.ctrl &&
            !key.meta &&
            key.name.length === 1 &&
            !isControlCharacter(key.name)
          ) {
            state.pluginInput += key.name;
          }
          refresh();
          return;
        }

        if (name === "up" || name === "k") {
          cursor = Math.max(0, cursor - 1);
        } else if (name === "down" || name === "j") {
          cursor = Math.min(CAPABILITY_NAMES.length + 2, cursor + 1);
        } else if (name === "space" && cursor >= 2) {
          toggleCapability(state, cursor - 2);
        } else if (name === "left" || name === "h") {
          cycleSelection(state, cursor, -1);
        } else if (name === "right" || name === "l") {
          cycleSelection(state, cursor, 1);
        } else if (name === "return" || name === "enter" || name === "linefeed") {
          if (cursor < CAPABILITY_NAMES.length + 2) cursor += 1;
        }
        if (cursor === CAPABILITY_NAMES.length + 2) state.pluginInput = state.plugins.join(" ");
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
): string {
  const state = stateFromRequest(validateInstallOptions(request));
  return renderReview(
    state,
    selectedAction === "install" ? 0 : selectedAction === "change" ? 1 : 2,
  );
}

function stateFromRequest(request: InstallRequest): WizardState {
  const optional = {
    ...DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
    ...request.optional,
  };
  return {
    profile: request.profile ?? "default",
    tier: request.tier ?? "standard",
    optional: {
      computer_use: optional.computer_use ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.computer_use,
      work: optional.work ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.work,
      frontend: optional.frontend ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.frontend,
      security: optional.security ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.security,
    },
    plugins: [...(request.officialPlugins ?? [])],
    pluginInput: (request.officialPlugins ?? []).join(" "),
  };
}

function cycleSelection(state: WizardState, cursor: number, direction: -1 | 1): void {
  if (cursor === 0) {
    state.profile = cycle(PROFILE_NAMES, state.profile, direction);
  } else if (cursor === 1) {
    state.tier = cycle(SERVICE_TIERS, state.tier, direction);
  } else if (cursor >= 2 && cursor < CAPABILITY_NAMES.length + 2) {
    toggleCapability(state, cursor - 2);
  }
}

function toggleCapability(state: WizardState, index: number): void {
  const name = CAPABILITY_NAMES[index];
  if (name !== undefined) state.optional[name] = !state.optional[name];
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

function renderWizard(state: Readonly<WizardState>, cursor: number): string {
  const focused =
    cursor < 2
      ? cursor === 0
        ? "Choose the routing profile for the Root session."
        : "Choose how quickly services handle work."
      : cursor < CAPABILITY_NAMES.length + 2
        ? capabilityDescription(CAPABILITY_NAMES[cursor - 2]!)
        : "Optional plugin IDs separated by spaces. Enter continues to review.";
  const lines = [
    "HolyCodex  ·  install",
    "↑/↓ move   ←/→ change   Space toggle   Enter review   Esc cancel",
    "",
    "PROFILE",
    `${cursor === 0 ? "❯" : " "} Profile       ${state.profile}`,
    `${cursor === 1 ? "❯" : " "} Service tier  ${state.tier}`,
    "",
    "OPTIONAL CAPABILITIES",
    ...CAPABILITY_NAMES.map(
      (name, index) =>
        `${cursor === index + 2 ? "❯" : " "} ${capabilityLabel(name).padEnd(14)} ${state.optional[name] ? "[x] enabled" : "[ ] disabled"}`,
    ),
    "",
    "ADDITIONAL PLUGINS",
    ...wrapWizardLine(
      `${cursor === CAPABILITY_NAMES.length + 2 ? "❯" : " "} ${state.pluginInput || "(none)"}`,
    ),
    "",
    focused,
  ];
  return `${lines.join("\n")}\n`;
}

function renderReview(state: Readonly<WizardState>, selected: number): string {
  const actions = ["Install", "Change options / Redo", "Cancel"];
  const lines = [
    "HolyCodex  ·  review",
    "Review configuration",
    "↑/↓ choose   Enter confirm   Esc cancel",
    "",
    `Profile: ${state.profile}`,
    `Service tier: ${state.tier}`,
    "",
    "CAPABILITIES",
    ...CAPABILITY_NAMES.map(
      (name) => `  ${capabilityLabel(name)}: ${enabled(state.optional[name])}`,
    ),
    ...wrapWizardLine(
      `  Additional plugins: ${state.plugins.length === 0 ? "none" : state.plugins.join(" ")}`,
    ),
    "",
    ...actions.map((action, index) => `${index === selected ? "›" : " "} ${action}`),
  ];
  return `${lines.join("\n")}\n`;
}

function capabilityDescription(name: OptionalCapabilityName): string {
  switch (name) {
    case "work":
      return "Work plugins for documents, spreadsheets, and presentations.";
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
