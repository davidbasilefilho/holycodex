// SPDX-License-Identifier: Apache-2.0

/** Minimal Codex 0.160.0 catalog fixture for deterministic installer runtime tests. */
export function currentModelCatalogJson(rootContextSupport: boolean | "missing" = true): string {
  const root = [
    "Sol upstream.",
    "# When to ask the user for permission\nAsk everything.",
    `# Autonomy and persistence\nWhen the user's prompt indicates a request for action, such as "can you...", "I want to...", "help me..." and similar expressions, treat these as instructions to do the work and take action. Do not stop at acknowledging capability (e.g. "Yes…"), proposing a plan, or offering to continue. Do not settle for a partial or "helpful enough" solution that does not fully satisfy the user's task to save time, effort or tokens. If a task requires sustained work, complete all the necessary work until the intended outcome is fulfilled.`,
    "\nIf the user's intent or task scope is unclear, progress towards the user's goal with the information available and then ask the user for clarification while continuing independent work.\n",
    "# Working with the user\nSend progress every 60 seconds.",
    "# Rules for getting work done\n- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\nKeep shell arguments safely quoted.",
    "# Using skills\nThe first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.",
  ].join("\n");
  const luna = [
    "Luna upstream.",
    "# Personality\nBe concise.",
    "# When to ask the user for permission\nAsk Root.",
    "# Autonomy and persistence\nPersist.",
    "# Working with the user\nUse request_user_input_async and send_user_message_async.",
    "# Rules for getting work done\n- Avoid performing blocking sleep or wait calls longer than 60 seconds, as they may prevent you from communicating with the user for their duration.\n- Do not add or run tests unless the user asks you to test or verify implementation.",
    "# Using skills\nThe first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.",
  ].join("\n");
  return JSON.stringify({
    models: [
      {
        slug: "gpt-6.1-sol",
        multi_agent_version: "v2",
        ...(rootContextSupport === "missing"
          ? {}
          : { supports_experimental_context: rootContextSupport }),
        model_messages: { instructions_template: root },
      },
      {
        slug: "gpt-6-luna",
        multi_agent_version: "v2",
        model_messages: { instructions_template: luna },
      },
    ],
  });
}
