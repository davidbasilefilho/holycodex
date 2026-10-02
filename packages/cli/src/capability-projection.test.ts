// SPDX-License-Identifier: Apache-2.0

import { expect, test } from "bun:test";

import { desiredRootConfig } from "./installer.ts";
import { currentModelCatalogJson } from "./model-catalog-fixture.ts";
import { modelSupportsExperimentalContext, patchCurrentModelCatalog } from "./model-catalog.ts";
import {
  projectNativeAgents,
  renderNativeAgent,
  rootDeveloperInstructions,
} from "./native-agents.ts";

test("projects only selected visual providers into Root and both visual specialists", () => {
  for (const browserUse of [false, true]) {
    for (const computerUse of [false, true]) {
      const options = { browserUse, computerUse };
      const projections = [
        rootDeveloperInstructions(options),
        ...projectNativeAgents("default")
          .filter((agent) => agent.name === "Worker.visual" || agent.name === "Reviewer.visual")
          .map((agent) => renderNativeAgent(agent, options)),
      ];
      expect(projections).toHaveLength(3);
      for (const projection of projections) {
        expect(projection.includes("Browser Use / ")).toBe(browserUse);
        expect(projection.includes("Computer Use")).toBe(computerUse);
        expect(projection).not.toContain("if Browser Use is installed");
        expect(projection).not.toContain("only when the capability");
        expect(projection).not.toContain("actually available");
        if (browserUse) {
          expect(projection).toContain(
            "open and inspect the standalone temporary HTML with Browser Use / IAB",
          );
          expect(
            projection.includes(
              "Use Computer Use for HTML interactions Browser Use cannot perform.",
            ),
          ).toBe(computerUse);
        } else if (computerUse) {
          expect(projection).toContain(
            "open and inspect the standalone temporary HTML with Computer Use",
          );
        } else {
          expect(projection).toContain("give the standalone temporary HTML file to the user");
        }
      }
    }
  }
});

test("derives V1 model instructions from each selected current catalog entry", () => {
  const sol = [
    "You are Codex based on Sol.",
    `# When to ask the user for permission\n${"Ask for everything and explain the rationale repeatedly. ".repeat(20)}\n`,
    `# Autonomy and persistence\nWhen the user's prompt indicates a request for action, such as "can you...", "I want to...", "help me..." and similar expressions, treat these as instructions to do the work and take action. Do not stop at acknowledging capability (e.g. "Yes…"), proposing a plan, or offering to continue. Do not settle for a partial or "helpful enough" solution that does not fully satisfy the user's task to save time, effort or tokens.\n`,
    "If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.\n",
    "If the user's intent or task scope is unclear, progress towards the user's goal with the information available and then ask the user for clarification while continuing independent work.\n",
    "# Working with the user\nSend an update every 60 seconds.\n",
    "# Rules for getting work done\n- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n- Treat shell command text as code and quote shell inputs safely.\n- Run the smallest meaningful proof required for acceptance.\n",
    "# Using skills\nThe first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.\n",
  ].join("\n");
  const luna = [
    "You are Codex based on Luna.",
    "# Personality\nBe concise.\n",
    "# When to ask the user for permission\nAsk Root.\n",
    "# Autonomy and persistence\nPersist.\n",
    `# Working with the user\n${"Use request_user_input_async and send_user_message_async. Ask the user optional questions and report progress through commentary.\n".repeat(20)}`,
    "# Rules for getting work done\n- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n- Do not add or run tests unless the user asks you to test or verify implementation.\n- Keep changes small.\n",
    "# Using skills\nThe first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.\n",
  ].join("\n");
  const untouched = { slug: "other-model", marker: { preserve: true } };
  const result = patchCurrentModelCatalog({
    catalog_revision: 3,
    models: [
      { slug: "gpt-6.1-sol", model_messages: { instructions_template: sol }, extra: "preserve" },
      { slug: "gpt-6-luna", model_messages: { instructions_template: luna, tools: ["kept"] } },
      { ...untouched, model_messages: { instructions_template: "Unchanged." } },
    ],
  });
  const models = result.catalog["models"] as ReadonlyArray<Record<string, unknown>>;
  const patchedSol = models[0]!;
  const patchedLuna = models[1]!;

  expect(patchedSol["multi_agent_version"]).toBe("v1");
  expect(patchedSol["extra"]).toBe("preserve");
  expect(patchedLuna["model_messages"]).toMatchObject({ tools: ["kept"] });
  expect(models[2]).toEqual({
    ...untouched,
    model_messages: { instructions_template: "Unchanged." },
  });
  expect(result.rootInstructions).toContain("Sol");
  expect(result.rootInstructions.length).toBeLessThan(sol.length);
  expect(result.rootInstructions).not.toContain("every 60 seconds");
  expect(result.rootInstructions).not.toContain("longer than 60 seconds");
  expect(result.rootInstructions).not.toContain("first time in a conversation");
  expect(result.rootInstructions).not.toContain("indicates a request for action");
  expect(result.rootInstructions).toContain(
    "Root delegates every delegable action through bounded Assignments",
  );
  expect(result.rootInstructions).toContain(
    "If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.",
  );
  expect(result.rootInstructions).toContain("Quote shell inputs safely");
  expect(result.rootInstructions).toContain(
    "Run the smallest meaningful proof required for acceptance.",
  );
  expect(result.specialistInstructions).toContain("Luna");
  expect(result.specialistInstructions).not.toContain("request_user_input_async");
  expect(result.specialistInstructions).not.toContain("send_user_message_async");
  expect(result.specialistInstructions).not.toContain("unless the user asks you to test");
  expect(result.specialistInstructions).not.toContain("longer than 60 seconds");
  expect(result.specialistInstructions).not.toContain("first time in a conversation");
  expect(result.specialistInstructions.length).toBeLessThan(luna.length);
  expect(result.catalog["catalog_revision"]).toBe(3);
  expect(() =>
    patchCurrentModelCatalog({
      models: [
        { slug: "gpt-6.1-sol", model_messages: { instructions_template: "upstream changed" } },
        { slug: "gpt-6-luna", model_messages: { instructions_template: luna } },
      ],
    }),
  ).toThrow(/Codex direct-execution guidance changed/u);
  expect(() =>
    patchCurrentModelCatalog({
      models: [
        {
          slug: "gpt-6.1-sol",
          model_messages: {
            instructions_template: sol.replace(
              "tokens.\n\nIf a task requires sustained work",
              "tokens. This upstream clause is unknown.\n\nIf a task requires sustained work",
            ),
          },
        },
        { slug: "gpt-6-luna", model_messages: { instructions_template: luna } },
      ],
    }),
  ).toThrow(/Codex direct-execution guidance changed/u);
  expect(() =>
    patchCurrentModelCatalog({
      models: [
        {
          slug: "gpt-6.1-sol",
          model_messages: {
            instructions_template: sol.replace(
              "If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.",
              "Unknown upstream instruction.",
            ),
          },
        },
        { slug: "gpt-6-luna", model_messages: { instructions_template: luna } },
      ],
    }),
  ).toThrow(/Codex direct-execution guidance changed/u);
  expect(() =>
    patchCurrentModelCatalog({
      models: [
        {
          slug: "gpt-6.1-sol",
          model_messages: {
            instructions_template: sol.replace(
              "fulfilled.\n\nIf the user's intent or task scope is unclear",
              "fulfilled.\n\nUnknown upstream instruction.\n\nIf the user's intent or task scope is unclear",
            ),
          },
        },
        { slug: "gpt-6-luna", model_messages: { instructions_template: luna } },
      ],
    }),
  ).toThrow(/Codex direct-execution guidance changed/u);
  expect(() =>
    patchCurrentModelCatalog({
      models: [
        {
          slug: "gpt-6.1-sol",
          model_messages: {
            instructions_template: sol.replace(
              "independent work.\n\n# Working with the user",
              "independent work.\n\nUnknown upstream instruction.\n\n# Working with the user",
            ),
          },
        },
        { slug: "gpt-6-luna", model_messages: { instructions_template: luna } },
      ],
    }),
  ).toThrow(/Codex direct-execution guidance changed/u);
  const staleLunas = [
    luna.replace(
      "- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n",
      "",
    ),
    luna.replace(
      "- Do not add or run tests unless the user asks you to test or verify implementation.\n",
      "",
    ),
    luna.replace(
      "The first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.",
      "",
    ),
  ];
  for (const staleLuna of staleLunas) {
    expect(() =>
      patchCurrentModelCatalog({
        models: [
          { slug: "gpt-6.1-sol", model_messages: { instructions_template: sol } },
          { slug: "gpt-6-luna", model_messages: { instructions_template: staleLuna } },
        ],
      }),
    ).toThrow(/expected Codex specialist/u);
  }
  expect(() =>
    patchCurrentModelCatalog({
      models: [
        {
          slug: "gpt-6.1-sol",
          model_messages: {
            instructions_template: sol.replace(
              /When the user's prompt indicates[\s\S]*?tokens\./u,
              "",
            ),
          },
        },
        { slug: "gpt-6-luna", model_messages: { instructions_template: luna } },
      ],
    }),
  ).toThrow(/Codex direct-execution guidance changed/u);
  expect(() =>
    patchCurrentModelCatalog({
      models: [
        {
          slug: "gpt-6.1-sol",
          model_messages: {
            instructions_template: sol.replace(
              "The first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.",
              "",
            ),
          },
        },
        { slug: "gpt-6-luna", model_messages: { instructions_template: luna } },
      ],
    }),
  ).toThrow(/Codex skill-announcement guidance changed/u);
});

test("patches the Codex 0.160.0 source prompt on install and upgrade", () => {
  const sourceCatalog: unknown = JSON.parse(currentModelCatalogJson());
  const installed = patchCurrentModelCatalog(sourceCatalog);
  const upgraded = patchCurrentModelCatalog(sourceCatalog);
  expect(upgraded.catalog).toEqual(installed.catalog);
  expect(installed.rootInstructions).toContain(
    "Root delegates every delegable action through bounded Assignments",
  );
  expect(installed.rootInstructions).toContain(
    "If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.",
  );
  expect(installed.specialistInstructions).toContain("Execute only the one bounded Assignment");
});

test("projects context management only when the selected model advertises support", () => {
  const catalog = {
    models: [
      { slug: "gpt-6.1-sol", supports_experimental_context: true },
      { slug: "gpt-6-astra", supports_experimental_context: false },
      { slug: "gpt-6-luna" },
    ],
  };

  expect(modelSupportsExperimentalContext(catalog, "gpt-6.1-sol")).toBe(true);
  expect(modelSupportsExperimentalContext(catalog, "gpt-6-astra")).toBe(false);
  expect(modelSupportsExperimentalContext(catalog, "gpt-6-luna")).toBe(false);
  expect(
    desiredRootConfig("default", "standard", {}, "C:/codex-home", catalog)[
      "features.context_management.experimental_mode"
    ],
  ).toBe(true);
  expect(
    desiredRootConfig("default", "standard", {}, "C:/codex-home", {
      models: [{ slug: "gpt-6.1-sol", supports_experimental_context: false }],
    })["features.context_management.experimental_mode"],
  ).toBeUndefined();
  expect(
    desiredRootConfig("default", "standard", {})["features.context_management.experimental_mode"],
  ).toBeUndefined();
});
