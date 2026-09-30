// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
  type OptionalCapabilityName,
  type ProfileName,
  type ServiceTier,
} from "@holycodex/core";

import { colorEnabled, paintTerminal, TERMINAL_THEME } from "./help.ts";
import { validateInstallOptions, type InstallOptions, type InstallRequest } from "./installer.ts";
import type { HumanRenderOptions } from "./types.ts";
import type {
  ConflictDecision,
  InstallWizardResult,
  InstallReview,
  InstallReviewResult,
  InstallReviewTool,
  ManagedConflict,
} from "./types.ts";

const PROFILE_NAMES: readonly ProfileName[] = ["low", "default", "high"];
const SERVICE_TIERS: readonly ServiceTier[] = ["standard", "fast", "fast-all"];
const CAPABILITY_NAMES: readonly OptionalCapabilityName[] = [
  "sites",
  "browser_use",
  "computer_use",
];

/** Public CLI type describing wizard state. */
export type WizardState = {
  /** The profile in wizard state. */
  profile: ProfileName;
  /** The tier in wizard state. */
  tier: ServiceTier;
  /** The optional in wizard state. */
  optional: Record<OptionalCapabilityName, boolean>;
  /** The plugins in wizard state. */
  plugins: string[];
  /** The plugin input in wizard state. */
  pluginInput: string;
  /** The plugin cursor in wizard state. */
  pluginCursor: number;
};

/** Public CLI type describing wizard key. */
export type WizardKey = Readonly<{
  name: string;
  ctrl?: boolean;
  shift?: boolean;
  meta?: boolean;
}>;

/** Public CLI type describing wizard configuration transition. */
export type WizardConfigurationTransition = Readonly<{
  cursor: number;
  action: "render" | "review" | "cancel";
}>;

/** Public CLI type describing conflict screen state. */
export type ConflictScreenState = {
  /** The conflicts in conflict screen state. */
  conflicts: readonly ManagedConflict[];
  /** The decisions in conflict screen state. */
  decisions: Record<string, ConflictDecision>;
};

/** Public CLI type describing conflict screen transition. */
export type ConflictScreenTransition = Readonly<{
  cursor: number;
  action: "render" | "continue" | "back" | "cancel";
}>;

/** Result returned by conflict screen operations. */
export type ConflictScreenResult =
  | Readonly<{ action: "continue"; decisions: Readonly<Record<string, ConflictDecision>> }>
  | Readonly<{ action: "back" | "cancel" }>;

/** Streams used by the OpenTUI renderer, primarily for embedded interactive callers. */
export type OpenTuiInstallWizardOptions = Readonly<{
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  /** Override terminal detection for callers that provide an output stream wrapper. */
  stdoutIsTTY?: boolean;
  /** Environment used for the shared terminal color policy. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Initial renderer width, useful for embedded terminals and deterministic tests. */
  width?: number;
  /** Initial renderer height, useful for embedded terminals and deterministic tests. */
  height?: number;
}>;

/** State rendered by the final, read-only install or upgrade review. */
export type InstallReviewScreenState = Readonly<{
  review: InstallReview;
  selected: number;
}>;

/** Result of applying one key to the final install or upgrade review. */
export type InstallReviewScreenTransition = Readonly<{
  selected: number;
  action: "render" | "choose" | "back" | "cancel";
}>;

type OpenTuiModule = typeof import("@opentui/core");
type OpenTuiStyledText = import("@opentui/core").StyledText;
type OpenTuiTextChunk = import("@opentui/core").TextChunk;

type NativeTone =
  | "argument"
  | "disabled"
  | "enabled"
  | "error"
  | "focus"
  | "heading"
  | "hint"
  | "success"
  | "warning";
type NativeSegment = Readonly<{ text: string; tone?: NativeTone }>;
type NativeLine = readonly NativeSegment[];

function nativeRendererOptions(options: OpenTuiInstallWizardOptions): Readonly<{
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  width?: number;
  height?: number;
}> {
  return {
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
    ...(options.width === undefined ? {} : { width: options.width }),
    ...(options.height === undefined ? {} : { height: options.height }),
  };
}

function nativeColorEnabled(options: OpenTuiInstallWizardOptions): boolean {
  const stdoutIsTTY =
    options.stdoutIsTTY ??
    (options.stdout === undefined ? process.stdout.isTTY === true : options.stdout.isTTY === true);
  return colorEnabled({
    stdoutIsTTY,
    env: options.env ?? process.env,
    stream: "stdout",
  });
}

function nativeLine(...segments: NativeSegment[]): NativeLine {
  return segments;
}

function nativeTextLine(text: string, tone?: NativeTone): NativeLine {
  return nativeLine({ text, ...(tone === undefined ? {} : { tone }) });
}

function nativeStyledChunk(
  opentui: OpenTuiModule,
  text: string,
  tone: NativeTone,
): OpenTuiTextChunk {
  const colored = opentui.fg(TERMINAL_THEME[tone])(text);
  return tone === "heading" || tone === "focus" ? opentui.bold(colored) : colored;
}

function nativeStyledText(
  opentui: OpenTuiModule,
  lines: readonly NativeLine[],
  color: boolean,
): OpenTuiStyledText {
  const chunks: OpenTuiTextChunk[] = [];
  lines.forEach((line, lineIndex) => {
    for (const segment of line) {
      if (segment.text.length === 0) continue;
      if (!color || segment.tone === undefined)
        chunks.push(...opentui.stringToStyledText(segment.text).chunks);
      else chunks.push(nativeStyledChunk(opentui, segment.text, segment.tone));
    }
    if (lineIndex < lines.length - 1) chunks.push(...opentui.stringToStyledText("\n").chunks);
  });
  chunks.push(...opentui.stringToStyledText("\n").chunks);
  return new opentui.StyledText(chunks);
}

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
    ...nativeRendererOptions(rendererOptions),
    exitOnCtrlC: true,
    clearOnShutdown: true,
  });
  const color = nativeColorEnabled(rendererOptions);
  const text = new opentui.TextRenderable(renderer, {
    content: nativeWizardContent(opentui, state, 0, color),
  });
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
        ? nativeReviewContent(opentui, state, reviewChoice, color)
        : nativeWizardContent(opentui, state, cursor, color);
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

/** Build one conflict review state, retaining valid prior decisions before applying defaults. */
export function stateFromConflicts(
  conflicts: readonly ManagedConflict[],
  priorDecisions: Readonly<Record<string, ConflictDecision>> = {},
): ConflictScreenState {
  const decisions: Record<string, ConflictDecision> = {};
  for (const conflict of conflicts) {
    const identity = conflictIdentity(conflict);
    const valid = actionableConflictDecisions(conflict);
    const prior = priorDecisions[identity];
    const preferred = valid.includes(prior ?? "cancel")
      ? prior!
      : defaultConflictDecision(conflict, valid);
    decisions[identity] = valid.includes(preferred) ? preferred : (valid[0] ?? "cancel");
  }
  return { conflicts, decisions };
}

/** Apply one keyboard action to the conflict review screen. */
export function applyConflictScreenKey(
  state: ConflictScreenState,
  cursor: number,
  key: WizardKey,
): ConflictScreenTransition {
  const rawName = key.name;
  const name = rawName.toLowerCase();
  const shifted = key.shift === true || (rawName.length === 1 && rawName !== rawName.toLowerCase());
  if (name === "escape") return { cursor, action: "back" };
  if (key.ctrl === true && name === "c") return { cursor, action: "cancel" };
  if (name === "up" || (name === "k" && !shifted)) {
    return { cursor: Math.max(0, cursor - 1), action: "render" };
  }
  if (name === "down" || name === "j") {
    return {
      cursor: Math.min(Math.max(0, state.conflicts.length - 1), cursor + 1),
      action: "render",
    };
  }
  if (name === "return" || name === "enter" || name === "linefeed") {
    return {
      cursor,
      action: state.conflicts.some((conflict) => actionableConflictDecisions(conflict).length === 0)
        ? "cancel"
        : "continue",
    };
  }
  if (name === "a" && key.ctrl !== true) {
    setDecisionForValidConflicts(state, "replace");
    return { cursor, action: "render" };
  }
  if ((name === "k" || rawName === "K") && key.ctrl !== true) {
    if (name === "k" && !shifted) {
      return { cursor: Math.max(0, cursor - 1), action: "render" };
    }
    setDecisionForValidConflicts(state, "keep");
    return { cursor, action: "render" };
  }
  if (name === "left" || name === "right") {
    cycleConflictDecision(state, cursor, name === "left" ? -1 : 1);
  }
  return { cursor, action: "render" };
}

/** Render the complete conflict list and the focused conflict's current action. */
export function renderConflictScreen(
  conflicts: readonly ManagedConflict[],
  decisions: Readonly<Record<string, ConflictDecision>> = stateFromConflicts(conflicts).decisions,
  cursor = 0,
  options: HumanRenderOptions = {},
): string {
  const color = colorEnabled({ ...options, stream: "stdout" });
  const width = process.stdout.columns ?? 80;
  const height = process.stdout.rows ?? 24;
  return `${conflictScreenLines(conflicts, decisions, cursor, width, height)
    .map((line) =>
      line
        .map((segment) =>
          segment.tone === undefined
            ? segment.text
            : paintTerminal(segment.text, segment.tone, color),
        )
        .join(""),
    )
    .join("\n")}\n`;
}

/** Run the one native OpenTUI conflict review and return all selected decisions. */
export async function runOpenTuiConflictResolver(
  conflicts: readonly ManagedConflict[],
  rendererOptions: OpenTuiInstallWizardOptions = {},
  priorDecisions: Readonly<Record<string, ConflictDecision>> = {},
): Promise<ConflictScreenResult> {
  const opentui = await import("@opentui/core");
  const state = stateFromConflicts(conflicts, priorDecisions);
  const renderer = await opentui.createCliRenderer({
    ...nativeRendererOptions(rendererOptions),
    exitOnCtrlC: true,
    clearOnShutdown: true,
  });
  const color = nativeColorEnabled(rendererOptions);
  const text = new opentui.TextRenderable(renderer, {
    content: nativeConflictContent(
      opentui,
      state.conflicts,
      state.decisions,
      0,
      color,
      rendererOptions.width ?? process.stdout.columns ?? 80,
      rendererOptions.height ?? process.stdout.rows ?? 24,
    ),
  });
  renderer.root.add(text);
  return await new Promise<ConflictScreenResult>((resolve, reject) => {
    let cursor = 0;
    let settled = false;
    const settle = (result: ConflictScreenResult): void => {
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
      text.content = nativeConflictContent(
        opentui,
        state.conflicts,
        state.decisions,
        cursor,
        color,
        rendererOptions.width ?? process.stdout.columns ?? 80,
        rendererOptions.height ?? process.stdout.rows ?? 24,
      );
      renderer.requestRender();
    };
    const onKey = (key: WizardKey): void => {
      try {
        const transition = applyConflictScreenKey(state, cursor, key);
        cursor = transition.cursor;
        if (transition.action === "continue")
          settle({ action: "continue", decisions: { ...state.decisions } });
        else if (transition.action === "back" || transition.action === "cancel")
          settle({ action: transition.action });
        else refresh();
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

/** Render the complete final transaction review shown immediately before approval. */
export function renderInstallReview(
  review: InstallReview,
  selected = 0,
  options: HumanRenderOptions = {},
): string {
  const color = colorEnabled({ ...options, stream: "stdout" });
  const actions = installReviewActions(review);
  const operation = review.operation === "upgrade" ? "upgrade" : "install";
  const version =
    review.operation === "upgrade" && review.fromVersion !== undefined
      ? `${review.fromVersion} → ${review.toVersion}`
      : review.toVersion;
  const conflictCount = Object.values(review.conflictCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const decisionCounts = installReviewDecisionCounts(review);
  const selectedDecisionCount = decisionCounts.keep + decisionCounts.replace;
  const lines = [
    paintTerminal(`HolyCodex · ${operation} review`, "heading", color),
    paintTerminal("Review the complete preflight plan before applying changes.", "hint", color),
    `Version: ${version}`,
    `Profile: ${review.profile}`,
    `Service tier: ${review.tier}`,
    "",
    paintTerminal("CAPABILITIES", "heading", color),
    ...CAPABILITY_NAMES.map(
      (name) =>
        `  ${capabilityLabel(name)}: ${paintTerminal(enabled(review.capabilities[name]), review.capabilities[name] ? "enabled" : "disabled", color)}`,
    ),
    ...wrapWizardLine(
      `  Additional plugins: ${review.additionalPlugins.length === 0 ? "none" : review.additionalPlugins.join(" ")}`,
    ),
    "",
    paintTerminal(`CONFLICTS (${conflictCount})`, "heading", color),
    ...(conflictCount === 0
      ? ["  none"]
      : Object.entries(review.conflictCounts).map(
          ([category, count]) => `  ${categoryLabel(category)}: ${count}`,
        )),
    ...(conflictCount === 0
      ? []
      : [
          "",
          paintTerminal(`DECISIONS (${selectedDecisionCount})`, "heading", color),
          `  Keep: ${decisionCounts.keep}`,
          `  Replace: ${decisionCounts.replace}`,
        ]),
    "",
    paintTerminal("PREREQUISITES", "heading", color),
    ...(review.tools.length === 0
      ? ["  none"]
      : review.tools.map((tool) => installReviewToolLine(tool, color))),
    "",
    paintTerminal("↑/↓ or j/k choose   Enter select   Esc back   Ctrl-C cancel", "hint", color),
    ...actions.map((action, index) =>
      paintTerminal(
        `${index === selected ? "›" : " "} ${installReviewActionLabel(action, review.operation)}`,
        index === selected
          ? "focus"
          : action === "apply"
            ? "success"
            : action === "change" || action === "resolve"
              ? "warning"
              : "error",
        color,
      ),
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function installReviewDecisionCounts(
  review: InstallReview,
): Readonly<{ readonly keep: number; readonly replace: number }> {
  let keep = 0;
  let replace = 0;
  for (const conflict of review.conflicts) {
    if (conflict.decision === "keep") keep += 1;
    else if (conflict.decision === "replace") replace += 1;
  }
  return { keep, replace };
}

function installReviewToolLine(tool: InstallReviewTool, color: boolean): string {
  const context7 = tool.name.toLowerCase() === "context7";
  const status = context7 ? context7ReviewStatus(tool.status) : tool.status;
  const tone = tool.status === "ready" || tool.status === "healthy" ? "success" : "warning";
  const detail = context7 || tool.detail === undefined ? "" : ` (${tool.detail})`;
  return `  ${tool.name}: ${paintTerminal(status, tone, color)}${detail}`;
}

/** Apply one keyboard action to the final install or upgrade review. */
export function applyInstallReviewKey(
  state: InstallReviewScreenState,
  key: WizardKey,
): InstallReviewScreenTransition {
  const actions = installReviewActions(state.review);
  const name = key.name.toLowerCase();
  if (name === "escape") {
    return { selected: state.selected, action: "back" };
  }
  if (key.ctrl === true && name === "c") {
    return { selected: state.selected, action: "cancel" };
  }
  if (name === "up" || name === "k") {
    return {
      selected: (state.selected + actions.length - 1) % actions.length,
      action: "render",
    };
  }
  if (name === "down" || name === "j") {
    return { selected: (state.selected + 1) % actions.length, action: "render" };
  }
  if (name === "return" || name === "enter" || name === "linefeed") {
    return { selected: state.selected, action: "choose" };
  }
  return { selected: state.selected, action: "render" };
}

/** Run the one native OpenTUI final review and return the selected action. */
export async function runOpenTuiInstallReview(
  review: InstallReview,
  rendererOptions: OpenTuiInstallWizardOptions = {},
): Promise<InstallReviewResult> {
  const opentui = await import("@opentui/core");
  const state: InstallReviewScreenState = { review, selected: 0 };
  const renderer = await opentui.createCliRenderer({
    ...nativeRendererOptions(rendererOptions),
    exitOnCtrlC: true,
    clearOnShutdown: true,
  });
  const color = nativeColorEnabled(rendererOptions);
  const text = new opentui.TextRenderable(renderer, {
    content: nativeInstallReviewContent(opentui, review, state.selected, color),
  });
  renderer.root.add(text);
  return await new Promise<InstallReviewResult>((resolve, reject) => {
    let selected = state.selected;
    let settled = false;
    const settle = (result: InstallReviewResult): void => {
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
      text.content = nativeInstallReviewContent(opentui, review, selected, color);
      renderer.requestRender();
    };
    const onKey = (key: WizardKey): void => {
      try {
        const transition = applyInstallReviewKey({ review, selected }, key);
        selected = transition.selected;
        if (transition.action === "cancel") {
          settle({ action: "cancel" });
        } else if (transition.action === "back") {
          settle({ action: "change" });
        } else if (transition.action === "choose") {
          const action = installReviewActions(review)[selected]!;
          settle({ action });
        } else refresh();
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

function installReviewActions(
  review: InstallReview,
): readonly ["apply", "change", ...("resolve" | "cancel")[]] {
  return (
    review.conflicts.length > 0
      ? ["apply", "change", "resolve", "cancel"]
      : ["apply", "change", "cancel"]
  ) as readonly ["apply", "change", ...("resolve" | "cancel")[]];
}

function installReviewActionLabel(
  action: "apply" | "change" | "resolve" | "cancel",
  operation: InstallReview["operation"],
): string {
  switch (action) {
    case "apply":
      return operation === "upgrade" ? "Upgrade" : "Install";
    case "change":
      return "Change options";
    case "resolve":
      return "Resolve conflicts";
    case "cancel":
      return "Cancel";
  }
}

function setDecisionForValidConflicts(
  state: ConflictScreenState,
  decision: "keep" | "replace",
): void {
  for (const conflict of state.conflicts) {
    const valid = actionableConflictDecisions(conflict);
    const selected =
      decision === "replace" &&
      conflict.category === "invalid-config" &&
      !valid.includes("replace") &&
      valid.includes("remove")
        ? "remove"
        : decision;
    if (valid.includes(selected)) state.decisions[conflictIdentity(conflict)] = selected;
  }
}

function cycleConflictDecision(
  state: ConflictScreenState,
  cursor: number,
  direction: -1 | 1,
): void {
  const conflict = state.conflicts[cursor];
  if (conflict === undefined) return;
  const identity = conflictIdentity(conflict);
  const choices = actionableConflictDecisions(conflict);
  if (choices.length === 0) return;
  const current = state.decisions[identity] ?? defaultConflictDecision(conflict, choices);
  const currentIndex = choices.indexOf(current);
  const index = currentIndex < 0 ? 0 : currentIndex;
  state.decisions[identity] =
    choices[(index + direction + choices.length) % choices.length] ?? choices[0]!;
}

function validConflictDecisions(conflict: ManagedConflict): readonly ConflictDecision[] {
  return (
    conflict.validDecisions ??
    (conflict.action === "remove" ? ["keep", "remove", "cancel"] : ["keep", "replace", "cancel"])
  );
}

function actionableConflictDecisions(conflict: ManagedConflict): readonly ConflictDecision[] {
  return validConflictDecisions(conflict).filter((decision) => decision !== "cancel");
}

function defaultConflictDecision(
  conflict: ManagedConflict,
  valid: readonly ConflictDecision[],
): ConflictDecision {
  const preferred =
    conflict.category === "invalid-config"
      ? "remove"
      : conflict.action === "remove"
        ? "remove"
        : "replace";
  return valid.includes(preferred) ? preferred : (valid[0] ?? "cancel");
}

function selectedConflictDecision(
  conflict: ManagedConflict,
  decisions: Readonly<Record<string, ConflictDecision>>,
): ConflictDecision {
  const valid = actionableConflictDecisions(conflict);
  const selected = decisions[conflictIdentity(conflict)];
  return valid.includes(selected ?? "cancel")
    ? selected!
    : defaultConflictDecision(conflict, valid);
}

function conflictScreenLines(
  conflicts: readonly ManagedConflict[],
  decisions: Readonly<Record<string, ConflictDecision>>,
  cursor: number,
  width: number,
  height: number,
): readonly NativeLine[] {
  const selected = Math.min(Math.max(cursor, 0), Math.max(0, conflicts.length - 1));
  const dense = conflicts.length + 11 > height;
  const lines: NativeLine[] = [
    nativeTextLine("HolyCodex · resolve conflicts", "heading"),
    nativeTextLine(`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`, "hint"),
    nativeTextLine("↑/↓ navigate   ←/→ change action   A replace all   K keep all", "hint"),
    nativeTextLine("Enter continue   Esc back   Ctrl-C cancel", "hint"),
  ];
  if (!dense) lines.push(nativeTextLine(""));
  lines.push(nativeTextLine("  ACTION    CONFIG", "heading"));

  const visibleCount = Math.max(1, height - (dense ? 9 : 12));
  const start = Math.max(0, Math.min(selected - visibleCount + 1, conflicts.length - visibleCount));
  conflicts.slice(start, start + visibleCount).forEach((conflict, offset) => {
    const index = start + offset;
    const valid = actionableConflictDecisions(conflict);
    const decision = selectedConflictDecision(conflict, decisions);
    const marker = index === selected ? ">" : " ";
    const label = valid.length === 0 ? "blocked" : decision === "remove" ? "replace" : decision;
    const tone: NativeTone =
      valid.length === 0
        ? "error"
        : decision === "replace"
          ? "warning"
          : decision === "keep"
            ? "disabled"
            : "error";
    const target = fitConflictText(conflict.target ?? conflict.key ?? conflict.path, width - 12);
    lines.push(
      nativeLine(
        { text: `${marker} ${label.padEnd(7)}   `, tone },
        { text: target, tone: index === selected ? "focus" : "argument" },
      ),
    );
  });

  if (conflicts.length === 0) {
    lines.push(nativeTextLine("No conflicts require a decision.", "success"));
    return lines;
  }

  if (!dense) lines.push(nativeTextLine(""));
  const focused = conflicts[selected]!;
  const decision = selectedConflictDecision(focused, decisions);
  const current = fitConflictText(formatConflictValue(focused.existing), width - 10);
  const desired =
    focused.desired === undefined && focused.action === "remove"
      ? conflictRemovalLabel(focused)
      : formatConflictValue(focused.desired);
  const install = fitConflictText(desired, width - 10);
  lines.push(
    nativeTextLine(fitConflictText(focused.target ?? focused.key ?? focused.path, width), "focus"),
  );
  lines.push(nativeLine({ text: "current   ", tone: "hint" }, { text: current }));
  lines.push(nativeLine({ text: "install   ", tone: "hint" }, { text: install }));
  lines.push(
    nativeTextLine(fitConflictText(conflictConsequence(focused, decision), width), "hint"),
  );
  return lines;
}

function fitConflictText(value: string, width: number): string {
  const compact = value
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const maxLength = Math.max(1, width);
  return compact.length <= maxLength ? compact : `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function categoryLabel(category: string): string {
  return category
    .split(/[-_]/u)
    .map((word) => (word.length === 0 ? word : `${word[0]!.toUpperCase()}${word.slice(1)}`))
    .join(" ");
}

function formatConflictValue(value: unknown): string {
  if (value === undefined) return "(unknown)";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "(unavailable)";
  }
}

function conflictConsequence(conflict: ManagedConflict, decision: ConflictDecision): string {
  if (decision === "keep") return "Keep the current value.";
  if (decision === "remove") {
    return conflict.category === "invalid-config"
      ? "Remove the invalid value so HolyCodex can create the required table."
      : "Remove the managed item.";
  }
  if (decision === "cancel") return "No available action can continue this operation.";
  return "Replace the current value with the HolyCodex value.";
}

function conflictRemovalLabel(conflict: ManagedConflict): string {
  return conflict.category === "invalid-config"
    ? "remove this conflicting user-owned value"
    : "remove this managed item";
}

function conflictIdentity(conflict: ManagedConflict): string {
  return conflict.identity ?? `${conflict.path}:${conflict.key ?? ""}:${conflict.action}`;
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
  const request: InstallRequest = {
    profile: state.profile,
    tier: state.tier,
    optional: { ...state.optional },
    officialPlugins: [...state.plugins],
  };
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
      browser_use: optional.browser_use ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
      computer_use: optional.computer_use ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.computer_use,
      sites: optional.sites ?? DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.sites,
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

function nativeWizardContent(
  opentui: OpenTuiModule,
  state: Readonly<WizardState>,
  cursor: number,
  color: boolean,
): OpenTuiStyledText {
  const pluginField = CAPABILITY_NAMES.length + 2;
  const focused =
    cursor < 2
      ? cursor === 0
        ? "Choose the routing profile for the Root session."
        : "Choose how quickly services handle work."
      : cursor < pluginField
        ? capabilityDescription(CAPABILITY_NAMES[cursor - 2]!)
        : "Optional plugin IDs separated by spaces. Enter continues to review.";
  const lines: NativeLine[] = [
    nativeTextLine("HolyCodex  ·  install", "heading"),
    nativeTextLine(
      "↑/↓ focus   ←/→ change choice   Space toggle   Enter review   Esc cancel",
      "hint",
    ),
    nativeTextLine(""),
    nativeTextLine("PROFILE", "heading"),
    nativeWizardChoice("Profile", state.profile, cursor === 0),
    nativeWizardChoice("Service tier", state.tier, cursor === 1),
    nativeTextLine(""),
    nativeTextLine("OPTIONAL CAPABILITIES", "heading"),
    ...CAPABILITY_NAMES.map((name, index) =>
      nativeWizardCapability(name, state.optional[name], cursor === index + 2),
    ),
    nativeTextLine(""),
    nativeTextLine("ADDITIONAL PLUGINS", "heading"),
    ...wrapWizardLine(`${cursor === pluginField ? "❯" : " "} ${state.pluginInput || "(none)"}`).map(
      (line) => nativeTextLine(line, cursor === pluginField ? "focus" : "argument"),
    ),
    nativeTextLine(""),
    nativeTextLine(focused, "hint"),
  ];
  return nativeStyledText(opentui, lines, color);
}

function nativeWizardChoice(label: string, value: string, focused: boolean): NativeLine {
  return nativeTextLine(
    `${focused ? "❯" : " "} ${label.padEnd(13)} ${value}`,
    focused ? "focus" : "argument",
  );
}

function nativeWizardCapability(
  name: OptionalCapabilityName,
  value: boolean,
  focused: boolean,
): NativeLine {
  const marker = value ? "[x] enabled" : "[ ] disabled";
  return nativeTextLine(
    `${focused ? "❯" : " "} ${capabilityLabel(name).padEnd(14)} ${marker}`,
    focused ? "focus" : value ? "enabled" : "disabled",
  );
}

function nativeReviewContent(
  opentui: OpenTuiModule,
  state: Readonly<WizardState>,
  selected: number,
  color: boolean,
): OpenTuiStyledText {
  const actions = ["Install", "Change options / Redo", "Cancel"];
  const lines: NativeLine[] = [
    nativeTextLine("HolyCodex  ·  review", "heading"),
    nativeTextLine("Review configuration", "heading"),
    nativeTextLine("↑/↓ choose   Enter confirm   Esc back", "hint"),
    nativeTextLine(""),
    nativeTextLine(`Profile: ${state.profile}`),
    nativeTextLine(`Service tier: ${state.tier}`),
    nativeTextLine(""),
    nativeTextLine("CAPABILITIES", "heading"),
    ...CAPABILITY_NAMES.map((name) =>
      nativeLine(
        { text: `  ${capabilityLabel(name)}: ` },
        {
          text: enabled(state.optional[name]),
          tone: state.optional[name] ? "enabled" : "disabled",
        },
      ),
    ),
    ...wrapWizardLine(
      `  Additional plugins: ${state.plugins.length === 0 ? "none" : state.plugins.join(" ")}`,
    ).map((line) => nativeTextLine(line, "argument")),
    nativeTextLine(""),
    ...actions.map((action, index) =>
      nativeTextLine(
        `${index === selected ? "›" : " "} ${action}`,
        index === selected ? "focus" : index === 0 ? "success" : index === 1 ? "warning" : "error",
      ),
    ),
  ];
  return nativeStyledText(opentui, lines, color);
}

function nativeConflictContent(
  opentui: OpenTuiModule,
  conflicts: readonly ManagedConflict[],
  decisions: Readonly<Record<string, ConflictDecision>>,
  cursor: number,
  color: boolean,
  width: number,
  height: number,
): OpenTuiStyledText {
  return nativeStyledText(
    opentui,
    conflictScreenLines(conflicts, decisions, cursor, width, height),
    color,
  );
}

function nativeInstallReviewContent(
  opentui: OpenTuiModule,
  review: InstallReview,
  selected: number,
  color: boolean,
): OpenTuiStyledText {
  const operation = review.operation === "upgrade" ? "upgrade" : "install";
  const version =
    review.operation === "upgrade" && review.fromVersion !== undefined
      ? `${review.fromVersion} → ${review.toVersion}`
      : review.toVersion;
  const conflictCount = Object.values(review.conflictCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const decisionCounts = installReviewDecisionCounts(review);
  const selectedDecisionCount = decisionCounts.keep + decisionCounts.replace;
  const lines: NativeLine[] = [
    nativeTextLine(`HolyCodex · ${operation} review`, "heading"),
    nativeTextLine("Review the complete preflight plan before applying changes.", "hint"),
    nativeTextLine(`Version: ${version}`),
    nativeTextLine(`Profile: ${review.profile}`),
    nativeTextLine(`Service tier: ${review.tier}`),
    nativeTextLine("CAPABILITIES", "heading"),
    ...CAPABILITY_NAMES.map((name) =>
      nativeLine(
        { text: `  ${capabilityLabel(name)}: ` },
        {
          text: enabled(review.capabilities[name]),
          tone: review.capabilities[name] ? "enabled" : "disabled",
        },
      ),
    ),
    nativeTextLine(
      `  Additional plugins: ${review.additionalPlugins.length === 0 ? "none" : review.additionalPlugins.join(" ")}`,
      "argument",
    ),
    nativeTextLine(`CONFLICTS (${conflictCount})`, "heading"),
    ...(conflictCount === 0
      ? [nativeTextLine("  none")]
      : Object.entries(review.conflictCounts).map(([category, count]) =>
          nativeTextLine(`  ${categoryLabel(category)}: ${count}`),
        )),
    ...(conflictCount === 0
      ? []
      : [
          nativeTextLine(`DECISIONS (${selectedDecisionCount})`, "heading"),
          nativeTextLine(`  Keep: ${decisionCounts.keep}`),
          nativeTextLine(`  Replace: ${decisionCounts.replace}`),
        ]),
    nativeTextLine("PREREQUISITES", "heading"),
    ...(review.tools.length === 0
      ? [nativeTextLine("  none")]
      : review.tools.map((tool) => nativeInstallReviewToolLine(tool))),
    nativeTextLine("↑/↓ or j/k choose   Enter select   Esc back   Ctrl-C cancel", "hint"),
    ...installReviewActions(review).map((action, index) =>
      nativeTextLine(
        `${index === selected ? "›" : " "} ${installReviewActionLabel(action, review.operation)}`,
        index === selected
          ? "focus"
          : action === "apply"
            ? "success"
            : action === "change" || action === "resolve"
              ? "warning"
              : "error",
      ),
    ),
  ];
  return nativeStyledText(opentui, lines, color);
}

function nativeInstallReviewToolLine(tool: InstallReviewTool): NativeLine {
  const context7 = tool.name.toLowerCase() === "context7";
  const status = context7 ? context7ReviewStatus(tool.status) : tool.status;
  const tone = tool.status === "ready" || tool.status === "healthy" ? "success" : "warning";
  const detail = context7 || tool.detail === undefined ? "" : ` (${tool.detail})`;
  return nativeLine(
    { text: `  ${tool.name}: ` },
    { text: status, tone },
    ...(detail.length === 0 ? [] : [{ text: detail }]),
  );
}

function context7ReviewStatus(status: InstallReviewTool["status"]): string {
  return status === "ready" ? "Use available ctx7" : "Attempt optional managed ctx7 install";
}

function capabilityDescription(name: OptionalCapabilityName): string {
  switch (name) {
    case "sites":
      return "ChatGPT Sites may depend on your account, region, workspace policy, or supported Codex surface.";
    case "browser_use":
      return "Browser Use depends on the Codex surface and runtime; it may be unavailable where unsupported.";
    case "computer_use":
      return "Computer Use has stronger platform and surface restrictions and can take external actions.";
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
  switch (name) {
    case "sites":
      return "ChatGPT Sites";
    case "browser_use":
      return "Browser Use";
    case "computer_use":
      return "Computer Use";
  }
}

function enabled(value: boolean): string {
  return value ? "enabled" : "disabled";
}

function isControlCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint === 127;
}
