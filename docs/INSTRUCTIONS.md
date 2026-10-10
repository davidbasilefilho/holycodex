# Model instructions

`overlay/holycodex/instructions/root.md` defines Root's stable responsibilities. `specialist.md` defines the shared specialist behavior; each Assignment supplies its Role.task separately. Keep task-specific authority and runtime-enforced behavior in their owning runtime and Assignment, not repeated in these prompts.

Keep these prompts concise and limited to behavior shared by their receiver. Keep specialized workflow details in the relevant skill, with conditional references for detail that only some cases need.

Durable model-facing instructions use US English and apply to any current owner and the projects they authorize. Resolve that owner's preferences, project context, and permissions from the current task and applicable guidance; another owner's history or approvals grant no authority. User-facing work follows the requested language. HolyCodex branding and facts about its own repository remain product identity, not assumptions about who is using it or which projects they own.

Root follows the target codebase's existing branch and PR conventions before considering a fallback. Only when no applicable convention exists and the project's versioning and workflow triggers support it, use `release/<version>/<type>/<change>` for release work or `exp/<experiment>/<type>/<change>` for experimental work. These are the only fallback families; example type names do not establish a mandatory catalog. Preserve mergeability, valid existing branches, and actual release versions with their full suffixes. Actual PR bases and dependencies determine a stack, not its branch names. HolyCodex's zero-major validator applies only to HolyCodex's own release stack. See [branch conventions and release stacks](BRANCHES.md).

Root's permanent `Writing instructions` section owns shared guidance for authoring model-facing instructions; do not package a general writing-instructions skill. The concise guidance adapts public instruction-design lessons from OpenAI's [Using GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol) and [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra). The latter discusses Astra specifically; its examples are design input, not guarantees about other model families.

Code assignments share a concise mergeability bar in the specialist base instructions, with implementation and independent review criteria in the `holycodex-policy` Role.task fragments. Public review examples are maintained in [`crates/holycodex-policy/evals/mergeability.md`](../crates/holycodex-policy/evals/mergeability.md); they clarify reviewer expectations and are not an automated or private model scorer.

`babysit-ci` reconciles required checks and relevant reviews for the current PR head. It uses the existing upstream event transport only after the host verifies the provider contract, and otherwise uses authorized reads with bounded waits. The [event boundary](../overlay/holycodex/skills/babysit-ci/references/events.md) records the verified transport and the currently missing GitHub runtime event schema. The typed `ci_watch` library does not activate a watcher or replace a scheduler; no polling reduction is claimed without live event evidence.

Root delegates bounded execution while retaining user decisions, VCS, integration, and final acceptance.
Assignments carry ownership, dependencies, and acceptance evidence. Relevant idle specialist reuse
must remain compatible with live capabilities, role rebinding, and independent-review constraints.
Follow-ups preserve accepted results and add incremental evidence; context continuity never substitutes
for a fresh check when a change invalidates earlier evidence. Visual roles inspect actual rendered
states and interactions. Functional, architectural, and visual acceptance scale to the task.

[Continuity evaluation scenarios](../crates/holycodex-policy/evals/continuity.md) define the evidence
needed for session-level evaluation. Deterministic policy tests and instruction packaging assertions
are not proof of model behavior, rendered quality, cache hits, or reduced latency.
