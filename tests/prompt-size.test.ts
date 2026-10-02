// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { patchCurrentModelCatalog } from "../packages/cli/src/model-catalog.ts";
import {
  projectNativeAgents,
  renderNativeAgent,
  rootDeveloperInstructions,
} from "../packages/cli/src/native-agents.ts";
import {
  DEFAULT_CAPABILITY_SELECTIONS,
  DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS,
} from "../packages/core/src/capabilities.ts";
import { ROLE_DEFINITIONS } from "../packages/core/src/routes.ts";
import { runChecked } from "../scripts/process.ts";

type PromptBudget = {
  codex: {
    cliVersion: string;
    sourceTemplates: Record<string, { chars: number; sha256: string }>;
  };
  growth: { minimumChars: number; proportion: number };
  patchedBaseChars: { root: number; specialist: number };
  rootEffectiveChars: {
    defaultCapabilities: number;
    allOptionalCapabilities: number;
  };
  specialistRoleMaximumEffectiveChars: Record<string, number>;
};

const promptBudgetPath = join(import.meta.dir, "fixtures", "prompt-size-budgets.json");
const promptBudget = JSON.parse(readFileSync(promptBudgetPath, "utf8")) as PromptBudget;

test("effective native prompts stay within reviewed model-derived size budgets", async () => {
  const codexVersion = (await runChecked(["codex", "--version"])).stdout.trim();
  expect(codexVersion, "installed Codex CLI version").toBe(promptBudget.codex.cliVersion);

  const explicitCatalogPath = process.env["CODEX_MODEL_CATALOG_PATH"];
  const catalogText =
    explicitCatalogPath === undefined
      ? (
          await runChecked(["codex", "debug", "models", "--bundled"], {
            maxOutputBytes: Number.MAX_SAFE_INTEGER,
          })
        ).stdout
      : readFileSync(explicitCatalogPath, "utf8");
  const currentCatalog = JSON.parse(catalogText) as Record<string, unknown>;
  const models = currentCatalog["models"];
  expect(Array.isArray(models)).toBe(true);
  if (!Array.isArray(models)) throw new Error("The current Codex catalog has no model entries.");

  for (const slug of ["gpt-6.1-sol", "gpt-6-luna"] as const) {
    const model = models.find(
      (candidate: unknown): candidate is Record<string, unknown> =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as Record<string, unknown>)["slug"] === slug,
    );
    const modelMessages = model?.["model_messages"];
    const instructionsTemplate =
      typeof modelMessages === "object" && modelMessages !== null
        ? (modelMessages as Record<string, unknown>)["instructions_template"]
        : undefined;
    expect(typeof instructionsTemplate, `${slug} source instructions template`).toBe("string");
    if (typeof instructionsTemplate !== "string") {
      throw new Error(`The current Codex catalog has no ${slug} instructions template.`);
    }
    const expectedSource = promptBudget.codex.sourceTemplates[slug];
    if (expectedSource === undefined) {
      throw new Error(`The reviewed prompt budget has no ${slug} source baseline.`);
    }
    expect(instructionsTemplate.length, `${slug} source template characters`).toBe(
      expectedSource.chars,
    );
    expect(
      createHash("sha256").update(instructionsTemplate).digest("hex"),
      `${slug} source template SHA-256`,
    ).toBe(expectedSource.sha256);
  }

  const patched = patchCurrentModelCatalog(currentCatalog);
  expectWithinBudget(
    patched.rootInstructions.length,
    promptBudget.patchedBaseChars.root,
    "patched Sol base",
  );
  expectWithinBudget(
    patched.specialistInstructions.length,
    promptBudget.patchedBaseChars.specialist,
    "patched Luna base",
  );
  const patchedBaseSizes = {
    root: sizeReport(patched.rootInstructions.length, promptBudget.patchedBaseChars.root),
    specialist: sizeReport(
      patched.specialistInstructions.length,
      promptBudget.patchedBaseChars.specialist,
    ),
  };
  const rootVariants = {
    defaultCapabilities: rootDeveloperInstructions({
      browserUse: DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
      computerUse: DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.computer_use,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
      security: DEFAULT_CAPABILITY_SELECTIONS.security,
    }),
    allOptionalCapabilities: rootDeveloperInstructions({
      browserUse: true,
      computerUse: true,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
      security: DEFAULT_CAPABILITY_SELECTIONS.security,
    }),
  };
  const rootSizes = Object.fromEntries(
    Object.entries(rootVariants).map(([variant, developerInstructions]) => {
      const effectiveChars = patched.rootInstructions.length + developerInstructions.length;
      const baseline =
        promptBudget.rootEffectiveChars[variant as keyof PromptBudget["rootEffectiveChars"]];
      expectWithinBudget(effectiveChars, baseline, `Root ${variant} effective instructions`);
      return [variant, effectiveChars];
    }),
  );
  const rootSizeLimits = Object.fromEntries(
    Object.entries(rootSizes).map(([variant, actualChars]) => [
      variant,
      sizeReport(
        actualChars,
        promptBudget.rootEffectiveChars[variant as keyof PromptBudget["rootEffectiveChars"]],
      ),
    ]),
  );
  const agents = projectNativeAgents("default", "standard");
  expect(agents).toHaveLength(
    ROLE_DEFINITIONS.reduce((total, role) => total + role.tasks.length, 0),
  );
  const specialistSizes = new Map<string, number>();
  for (const agent of agents) {
    const config = renderNativeAgent(agent, {
      browserUse: DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.browser_use,
      computerUse: DEFAULT_OPTIONAL_CAPABILITY_SELECTIONS.computer_use,
      frontend: DEFAULT_CAPABILITY_SELECTIONS.frontend,
    });
    const instructionLine = config
      .split("\n")
      .find((line) => line.startsWith("developer_instructions = "));
    expect(instructionLine, `${agent.name} native developer instructions`).toBeDefined();
    const encodedInstructions = instructionLine?.slice("developer_instructions = ".length);
    expect(encodedInstructions, `${agent.name} encoded instructions`).toBeDefined();
    const developerInstructions = JSON.parse(encodedInstructions ?? "null") as string;
    const effectiveChars = patched.specialistInstructions.length + developerInstructions.length;
    const role = agent.name.split(".")[0] ?? "";
    const baseline = promptBudget.specialistRoleMaximumEffectiveChars[role];
    expect(baseline, `${role} reviewed effective size baseline`).toBeDefined();
    expectWithinBudget(effectiveChars, baseline ?? 0, `${agent.name} effective instructions`);
    specialistSizes.set(role, Math.max(specialistSizes.get(role) ?? 0, effectiveChars));

    const roleDefinition = ROLE_DEFINITIONS.find((candidate) => candidate.role === role);
    const task = roleDefinition?.tasks.find(
      (candidate) => `${role}.${candidate.name}` === agent.name,
    );
    expect(task, `${agent.name} canonical task`).toBeDefined();
    expect(developerInstructions.startsWith(task?.instruction ?? "")).toBe(true);
    expect(developerInstructions.split(roleDefinition?.sharedInstruction ?? "\u0000")).toHaveLength(
      2,
    );
  }
  console.info(
    `Codex ${codexVersion} prompt sizes: ${JSON.stringify({
      patchedBaseChars: {
        root: patched.rootInstructions.length,
        specialist: patched.specialistInstructions.length,
      },
      rootEffectiveChars: rootSizes,
      rootEffectiveLimits: rootSizeLimits,
      patchedBaseLimits: patchedBaseSizes,
      specialistRoleMaximumEffectiveChars: Object.fromEntries(
        [...specialistSizes].map(([role, actualChars]) => [
          role,
          sizeReport(actualChars, promptBudget.specialistRoleMaximumEffectiveChars[role] ?? 0),
        ]),
      ),
    })}`,
  );
});

function expectWithinBudget(actualChars: number, baselineChars: number, subject: string): void {
  expect(
    actualChars,
    `${subject}: ${actualChars} chars exceeds reviewed baseline ${baselineChars} + ${sizeAllowance(baselineChars)}`,
  ).toBeLessThanOrEqual(promptSizeLimit(baselineChars));
}

function sizeReport(
  actualChars: number,
  baselineChars: number,
): {
  actualChars: number;
  baselineChars: number;
  limitChars: number;
} {
  return { actualChars, baselineChars, limitChars: promptSizeLimit(baselineChars) };
}

function promptSizeLimit(baselineChars: number): number {
  return baselineChars + sizeAllowance(baselineChars);
}

function sizeAllowance(baselineChars: number): number {
  return Math.max(
    promptBudget.growth.minimumChars,
    Math.ceil(baselineChars * promptBudget.growth.proportion),
  );
}
