---
name: writing-instructions
description: Use when model-facing instructions need authorship or review; make them coherent, scoped, and complete for their receiver.
---

# Writing instructions

Use this skill for model-facing instructions, including Root/session policy,
specialist and Role.task contracts, skills, and conditional workflows. Keep
shared behavior under one owner across model routes; account for model-specific
differences only when supported by evidence.

Before writing, identify the receiver's effective context: higher-priority and
user instructions, repository instructions, Role/task policy, relevant skills,
tools and capabilities, configuration, and current task context. Add only the
missing semantic delta. Resolve conflicts against the governing authority;
do not duplicate a meaning already supplied to the same receiver.

Give each meaning one authoritative owner at the narrowest scope that applies:
Root/session invariants in Root policy, repository conventions in AGENTS.md,
shared specialist boundaries in the specialist baseline, route-specific behavior
in Role.task, and genuinely conditional workflow or tool knowledge in a skill.
Generated projections derive from or validate against that owner. Invocation
metadata selects a branch; it does not become a second policy source.

Write instructions as short as possible without losing information that
materially constrains correct behavior. Preserve known task facts, defects,
distinctions, invariants, authority boundaries, required outcomes, and
acceptance conditions; do not make the receiver rediscover relevant known
facts. For implementation details that are not part of the contract and can be
reliably discovered during execution, point toward the authoritative source
instead of embedding them. Prefer generic guidance where the meaning is
general. Name exact implementation details only when needed to locate
authority, describe a known defect, preserve a distinction, or constrain exact
behavior.

Define the required outcome and completion evidence, bounded authority, relevant
constraints, material decisions or blockers that escalate, and stopping
conditions. Keep required lifecycle and safety invariants explicit. Give the
receiver room to choose routine safe, reversible, in-scope steps. A contract must
carry authorized work through its requested terminal state, including required
repair and proof; a first pass or pending gate is not completion.

Remove older-model competence scaffolding, fixed recipes without a required
ordering constraint, broad reading rituals, stale environment facts, duplicate
policy, and unnecessary questionnaires. Preserve meaningful repository checks
and review gates through their canonical owners instead of reproducing them in
every skill. Use configuration for verbosity rather than generic style padding.

Use a skill for a distinct conditional workflow or tool capability. Keep its
description short and specific enough to distinguish the invocation from
nearby skills. Avoid broad triggers that compete for ordinary work; audit
implicit invocation against the other skills the receiver can load.

Keep the main body focused on the shared outcome, boundaries, and acceptance
criteria. Link branch-specific tool knowledge or uncommon procedures from the
condition that needs them, so only the selected branch loads that detail. Do
not split a short coherent rule merely to create more files.

Keep display and invocation metadata in agents/openai.yaml and behavior in its
single authoritative source. References should supply a missing decision or
mechanic, not copies of the body or global policy. Preserve provenance and
license attribution under the original upstream names when renaming a skill.

An instruction change is complete when the receiver can act within its authority,
recognize completion and escalation boundaries, and return sufficient evidence;
the effective context has no contradictory or duplicate rule for that meaning.
Validate changed behavior with meaningful proof and repository-required gates,
using the canonical testing policy rather than inventing extra test rituals.
