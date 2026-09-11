---
name: writing-instructions
description: Use when authoring or reviewing model-facing instructions for GPT-6.
---

# Writing instructions

HolyCodex's canonical instruction-authoring skill has a GPT-6 → GPT-6 direction.
It covers developer_instructions, Root/session policy, specialist and Role.task
instructions, skill bodies, conditional workflows, and task-specific contracts.
Model routing identities do not change this behavioral target.

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

When creating or changing a skill's invocation boundary or conditional branches,
read [Skill mechanics](SKILL-MECHANICS.md). Other instruction changes do not need
that reference.

An instruction change is complete when the receiver can act within its authority,
recognize completion and escalation boundaries, and return sufficient evidence;
the effective context has no contradictory or duplicate rule for that meaning.
Validate changed behavior with meaningful proof and repository-required gates,
using the canonical testing policy rather than inventing extra test rituals.
