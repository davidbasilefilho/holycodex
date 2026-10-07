# Model instructions

`overlay/holycodex/instructions/root.md` defines Root's stable responsibilities. `specialist.md` defines the shared specialist behavior; each Assignment supplies its Role.task separately. Keep task-specific authority and runtime-enforced behavior in their owning runtime and Assignment, not repeated in these prompts.

Keep these prompts concise and limited to behavior shared by their receiver. Keep specialized workflow details in the relevant skill, with conditional references for detail that only some cases need.

Root's permanent `Writing instructions` section owns shared guidance for authoring model-facing instructions; do not package a general writing-instructions skill. The concise guidance adapts public instruction-design lessons from OpenAI's [Using GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol) and [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra). The latter discusses Astra specifically; its examples are design input, not guarantees about other model families.

Code assignments share a concise mergeability bar in the specialist base instructions, with implementation and independent review criteria in the `holycodex-policy` Role.task fragments. Public review examples are maintained in [`crates/holycodex-policy/evals/mergeability.md`](../crates/holycodex-policy/evals/mergeability.md); they clarify reviewer expectations and are not an automated or private model scorer.
