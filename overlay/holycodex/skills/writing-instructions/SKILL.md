---
name: writing-instructions
description: Use when authoring or reviewing model-facing instructions for a specific receiver.
---

# Writing instructions

Write or revise instructions for the named receiver and task. Preserve user and governing authority, assign each policy or invariant one clear owner, and state only the needed goal, constraints, observable success, and completion conditions. Keep guidance coherent and situation-specific; read only relevant sources and require proof proportional to the behavior being changed. Put runtime invariants in their enforcing implementation (including Rust), not in duplicated behavioral prose. Keep the normal workflow short. Add supporting files or conditional detail only when materially necessary, and load them only for the cases that need them. Avoid copied example blocks, invented policy taxonomies or rituals, broad mandatory reads, and token-counting or cost rules. When adapting upstream material, retain attribution and independently assess applicability.

## GPT-6 and GPT-6.1 authority

Before writing or revising instructions intended for GPT-6 or GPT-6.1, fetch and read the current official sources:

- [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6.1-sol)
- [GPT-6.1 Sol model page](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)

Use the guide and exact model page as primary authority for current family guidance and model-specific constraints. The blog describes GPT-6 Astra: apply its skill and instruction-design advice only where relevant, and do not present Astra-specific observations as guarantees about GPT-6.1 Sol or other models. Treat examples as illustrations, not policy templates; assess guidance for the actual receiver and workload. If a required source cannot be fetched or read, report that limitation rather than substituting cached notes.
