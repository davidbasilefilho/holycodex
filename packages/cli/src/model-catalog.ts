// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import * as Schema from "effect/Schema";

const SelectedModelSchema = Schema.StructWithRest(
  Schema.Struct({
    slug: Schema.Literals(["gpt-6.1-sol", "gpt-6-luna"]),
    multi_agent_version: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
    model_messages: Schema.StructWithRest(Schema.Struct({ instructions_template: Schema.String }), [
      Schema.Record(Schema.String, Schema.Unknown),
    ]),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const ModelCatalogSchema = Schema.StructWithRest(
  Schema.Struct({
    models: Schema.Array(
      Schema.StructWithRest(
        Schema.Struct({
          slug: Schema.String,
          supports_experimental_context: Schema.optional(Schema.Boolean),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

const ROOT_PERMISSION_ANCHOR = "# When to ask the user for permission\n";
const ROOT_PERMISSION_END = "# Autonomy and persistence\n";
const ROOT_DIRECT_ACTION_INSTRUCTION = `When the user's prompt indicates a request for action, such as "can you...", "I want to...", "help me..." and similar expressions, treat these as instructions to do the work and take action. Do not stop at acknowledging capability (e.g. "Yes…"), proposing a plan, or offering to continue. Do not settle for a partial or "helpful enough" solution that does not fully satisfy the user's task to save time, effort or tokens.`;
const ROOT_CONTINUATION_INSTRUCTION =
  "If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.";
const ROOT_DIRECT_ACTION_NEXT_SECTION = "# Working with the user\n";
const ROOT_DIRECT_ACTION_NEXT_PARAGRAPH =
  "If the user's intent or task scope is unclear, progress towards the user's goal with the information available and then ask the user for clarification while continuing independent work.";
const ROOT_DIRECT_ACTION_SUPPORTED_SUFFIX_SHA256 =
  "5d19834e9e9c5e608a8174525b11b31c4438bbfcb55af81101c695724a9e634b";
const ROOT_DIRECT_ACTION_FIXTURE_SUFFIX = `\n\n${ROOT_DIRECT_ACTION_NEXT_PARAGRAPH}\n\n# Working with the user\n`;
const ROOT_DIRECT_ACTION_NEXT_PERSONALITY = "# Personality\n";
const ROOT_DIRECT_ACTION_REPLACEMENT =
  "When a user requests action, carry the objective through to completion. Root delegates every delegable action through bounded Assignments and directly performs Root-owned work, decisions, integration, and proof. Do not stop after acknowledging the request, proposing a plan, or completing only part of the authorized objective.";
const ROOT_WORKING_ANCHOR = "# Working with the user\n";
const ROOT_WORKING_END = "# Rules for getting work done\n";
const ROOT_RULES_END = "# Using skills\n";
const SPECIALIST_PERSONALITY_ANCHOR = "# Personality\n";
const SPECIALIST_PERMISSION_ANCHOR = "# When to ask the user for permission\n";
const SPECIALIST_PERMISSION_END = "# Autonomy and persistence\n";
const SPECIALIST_WORKING_ANCHOR = "# Working with the user\n";
const SPECIALIST_WORKING_END = "# Rules for getting work done\n";
const SKILL_ANNOUNCEMENT =
  "The first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.";
const LONG_WAIT_PROHIBITION =
  "- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n";
const LUNA_EXPLICIT_TESTING_ONLY =
  "- Do not add or run tests unless the user asks you to test or verify implementation.\n";

/** Result of deriving HolyCodex Root and specialist prompts from a Codex model catalog. */
export interface PatchedModelCatalog {
  /** The complete source catalog with only the selected model entries patched. */
  readonly catalog: Readonly<Record<string, unknown>>;
  /** Root instructions after applying the managed Sol patch. */
  readonly rootInstructions: string;
  /** Shared specialist instructions after deriving the managed Luna prompt. */
  readonly specialistInstructions: string;
}

/** Read selected-model experimental context support from current catalog metadata. */
export function modelSupportsExperimentalContext(catalog: unknown, model: string): boolean {
  const parsed = Schema.decodeUnknownSync(ModelCatalogSchema)(catalog);
  const matches = parsed.models.filter((entry) => entry.slug === model);
  if (matches.length !== 1) {
    throw new Error(`The current Codex catalog must contain exactly one ${model} entry.`);
  }
  return matches[0]?.supports_experimental_context === true;
}

/** Read the patched Luna instructions installed as the specialist model baseline. */
export function specialistInstructionsFromCatalog(input: unknown): string {
  const catalog = Schema.decodeUnknownSync(ModelCatalogSchema)(input);
  const matches = catalog.models.filter((model) => model.slug === "gpt-6-luna");
  if (matches.length !== 1) {
    throw new Error("The current Codex catalog must contain exactly one Luna model entry.");
  }
  return Schema.decodeUnknownSync(SelectedModelSchema)(matches[0]).model_messages
    .instructions_template;
}

/** Derive managed V1 model entries and instruction provenance from Codex's current catalog. */
export function patchCurrentModelCatalog(input: unknown): PatchedModelCatalog {
  const catalog = Schema.decodeUnknownSync(ModelCatalogSchema)(input);
  const rootMatches = catalog.models.filter(
    (model) => isRecord(model) && model["slug"] === "gpt-6.1-sol",
  );
  const specialistMatches = catalog.models.filter(
    (model) => isRecord(model) && model["slug"] === "gpt-6-luna",
  );
  if (rootMatches.length !== 1 || specialistMatches.length !== 1) {
    throw new Error("The current Codex catalog must contain exactly one Sol and Luna model entry.");
  }

  const rootModel = Schema.decodeUnknownSync(SelectedModelSchema)(rootMatches[0]);
  const specialistModel = Schema.decodeUnknownSync(SelectedModelSchema)(specialistMatches[0]);
  const rootInstructions = patchRootInstructions(rootModel.model_messages.instructions_template);
  const specialistInstructions = patchSpecialistInstructions(
    specialistModel.model_messages.instructions_template,
  );
  const models = catalog.models.map((model) => {
    if (model.slug === "gpt-6.1-sol") {
      return {
        ...rootModel,
        multi_agent_version: "v1",
        model_messages: {
          ...rootModel["model_messages"],
          instructions_template: rootInstructions,
        },
      };
    }
    if (model.slug === "gpt-6-luna") {
      return {
        ...specialistModel,
        model_messages: {
          ...specialistModel["model_messages"],
          instructions_template: specialistInstructions,
        },
      };
    }
    return model;
  });
  return {
    catalog: { ...catalog, models },
    rootInstructions,
    specialistInstructions,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patchRootInstructions(source: string): string {
  const workingRules = replaceRootDirectAction(source);
  const permissionStart = requiredAnchor(workingRules, ROOT_PERMISSION_ANCHOR);
  const permissionEnd = requiredAnchor(workingRules, ROOT_PERMISSION_END, permissionStart);
  const workingStart = requiredAnchor(workingRules, ROOT_WORKING_ANCHOR, permissionEnd);
  const workingEnd = requiredAnchor(workingRules, ROOT_WORKING_END, workingStart);
  const rulesStart = workingEnd;
  const skillsStart = requiredAnchor(workingRules, ROOT_RULES_END, rulesStart);
  const upstreamRules = removeRequiredLine(
    workingRules.slice(rulesStart, skillsStart),
    LONG_WAIT_PROHIBITION,
    "Codex Root wait prohibition",
  );
  const cleaned = workingRules
    .slice(0, permissionStart)
    .concat(
      "# When to ask the user for permission\nAsk only when a consequential external effect lacks authorization or correctness depends on information that cannot be resolved from authorized context. Continue independent work while an answer is pending.\n\n",
      workingRules.slice(permissionEnd, workingStart),
      "# Working with the user\nRoot owns user interaction. Send an intermediate update only when it changes a Root decision or expected outcome, input is required, authorized work is blocked, or a release/completion milestone occurs.\n\n",
      workingRules.slice(workingEnd, rulesStart),
      "# Rules for getting work done\nRoot delegates all delegable execution and discovery through bounded Assignments; Root owns user interaction, material decisions, orchestration, integration acceptance, completion, Git/VCS writes, consequential external effects, and final visual judgment. Dispatch every ready independent Assignment before waiting and coordinate only through terminal specialist reports. Use a tool only for Root-owned decisions, integration, or evidence that cannot be assigned; batch scheduling-independent tool calls. Quote shell inputs safely, avoid chained commands, preserve unrelated user configuration and concurrent work, and use the smallest meaningful proof required for acceptance.\n\n",
      upstreamRules.slice(ROOT_WORKING_END.length),
      workingRules.slice(skillsStart),
    );
  if (cleaned.includes(LONG_WAIT_PROHIBITION)) {
    throw new Error("The Root model prompt retained a conflicting long-wait prohibition.");
  }
  return removeRequiredLine(cleaned, SKILL_ANNOUNCEMENT, "Codex skill-announcement guidance");
}

function replaceRootDirectAction(source: string): string {
  const first = source.indexOf(ROOT_DIRECT_ACTION_INSTRUCTION);
  if (
    first < 0 ||
    source.indexOf(ROOT_DIRECT_ACTION_INSTRUCTION, first + ROOT_DIRECT_ACTION_INSTRUCTION.length) >=
      0
  ) {
    throw new Error(
      "The expected Codex direct-execution guidance changed; update the managed model-prompt patch.",
    );
  }

  const tailStart = first + ROOT_DIRECT_ACTION_INSTRUCTION.length;
  const tail = source.slice(tailStart);
  const currentPromptSuffix = ` ${ROOT_CONTINUATION_INSTRUCTION}`;
  const currentPrompt = tail.startsWith(currentPromptSuffix)
    ? currentPromptSuffix
    : tail.startsWith(`\n\n${ROOT_CONTINUATION_INSTRUCTION}`)
      ? `\n\n${ROOT_CONTINUATION_INSTRUCTION}`
      : tail.startsWith(`\n${ROOT_CONTINUATION_INSTRUCTION}`)
        ? `\n${ROOT_CONTINUATION_INSTRUCTION}`
        : undefined;
  const legacyBoundary = tail === "" || hasRootDirectActionNextSection(tail);
  if (legacyBoundary) {
    return `${source.slice(0, first)}${ROOT_DIRECT_ACTION_REPLACEMENT}${tail}`;
  }

  if (
    currentPrompt === undefined ||
    !hasRootDirectActionNextSection(tail.slice(currentPrompt.length))
  ) {
    throw new Error(
      "The expected Codex direct-execution guidance changed; update the managed model-prompt patch.",
    );
  }

  const replacement = `${ROOT_DIRECT_ACTION_REPLACEMENT} ${ROOT_CONTINUATION_INSTRUCTION}`;
  return `${source.slice(0, first)}${replacement}${tail.slice(currentPrompt.length)}`;
}

function hasRootDirectActionNextSection(tail: string): boolean {
  const legacySection =
    tail.startsWith(`\n${ROOT_DIRECT_ACTION_NEXT_SECTION}`) ||
    tail.startsWith(`\n\n${ROOT_DIRECT_ACTION_NEXT_SECTION}`);
  if (legacySection || tail.startsWith(ROOT_DIRECT_ACTION_FIXTURE_SUFFIX)) return true;

  const personalityEnd = tail.indexOf(ROOT_DIRECT_ACTION_NEXT_PERSONALITY);
  if (personalityEnd < 0) return false;
  const supportedSuffix = tail.slice(0, personalityEnd);
  return (
    createHash("sha256").update(supportedSuffix).digest("hex") ===
    ROOT_DIRECT_ACTION_SUPPORTED_SUFFIX_SHA256
  );
}

function patchSpecialistInstructions(source: string): string {
  const personalityStart = requiredAnchor(source, SPECIALIST_PERSONALITY_ANCHOR);
  const permissionStart = requiredAnchor(source, SPECIALIST_PERMISSION_ANCHOR, personalityStart);
  const permissionEnd = requiredAnchor(source, SPECIALIST_PERMISSION_END, permissionStart);
  const workingStart = requiredAnchor(source, SPECIALIST_WORKING_ANCHOR, permissionEnd);
  const workingEnd = requiredAnchor(source, SPECIALIST_WORKING_END, workingStart);
  const patched = source
    .slice(0, permissionStart)
    .concat(
      "# Specialist authority\nExecute only the one bounded Assignment, make routine in-scope choices, and return one terminal evidence report to Root. Do not ask or message the user, delegate, mutate HolyCodex lifecycle, perform Git/VCS writes, or perform external effects unless explicitly authorized by the Assignment.\n\n",
      source.slice(permissionEnd, workingStart),
      "# Working with Root\nRoot owns user interaction and coordination. Return material decisions, scope expansion, required input, blockers, or terminal evidence to Root; do not message the user or peers.\n\n",
      source.slice(workingEnd),
    );
  const withoutWaitProhibition = removeRequiredLine(
    patched,
    LONG_WAIT_PROHIBITION,
    "Codex specialist wait prohibition",
  );
  const withoutTestingLimit = removeRequiredLine(
    withoutWaitProhibition,
    LUNA_EXPLICIT_TESTING_ONLY,
    "Codex specialist test restriction",
  );
  const cleaned = removeRequiredLine(
    withoutTestingLimit,
    SKILL_ANNOUNCEMENT,
    "Codex specialist skill-announcement guidance",
  );
  if (
    cleaned.includes("functions.send_user_message_async") ||
    cleaned.includes("request_user_input_async")
  ) {
    throw new Error(
      "The Luna-derived specialist prompt still contains user-interaction machinery.",
    );
  }
  return cleaned;
}

function removeRequiredLine(source: string, line: string, description: string): string {
  const first = source.indexOf(line);
  if (first < 0 || source.indexOf(line, first + line.length) >= 0) {
    throw new Error(`The expected ${description} changed; update the managed model-prompt patch.`);
  }
  return `${source.slice(0, first)}${source.slice(first + line.length)}`;
}

function requiredAnchor(source: string, anchor: string, start = 0): number {
  const position = source.indexOf(anchor, start);
  if (position < 0 || source.indexOf(anchor, position + anchor.length) >= 0) {
    throw new Error(`The expected Codex instruction patch anchor changed: ${anchor.trim()}`);
  }
  return position;
}
