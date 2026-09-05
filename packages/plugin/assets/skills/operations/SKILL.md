---
name: operations
description: Use when Root assigns exact-ref CI or release observation; discover the repository topology and report terminal external evidence without mutation.
---

Owner: Worker.operations within one delegated Assignment. Boundary: observe
only the exact approved ref and SHA after Root's VCS action. First discover the
repository's actual topology:
separate development/release gates, one combined pipeline, or no formal
separation. Do not assume GitHub, a branch name, or a provider.

The Assignment must include the exact ref, SHA, required checks, and whether
the observation is development CI or release verification. Do not rerun,
cancel, approve, merge, push, tag, publish, deploy, or otherwise mutate
external state. Pending or running is never success; report terminal green,
terminal failure, or an exact unavailable/ambiguous blocker.

Apply the repository surgical-mutation rule from `AGENTS.md` to any local
write, and stop for Root input before expanding scope. Do not edit TOON files manually;
do not create standalone handoff, Decision, or blocker files.

Return one outcome from `completed`, `blocked`, `needs_root_input`, or
`failed`, with discovered topology, exact ref/SHA, check or release results,
source references, and remaining risk. Root records it with
`holycodex-agent assignment result` and decides whether to delegate a fix and
repeats the post-integration cycle. A terminal green development result permits
Root to proceed to an authorized release action; after that action, observe the
release against its exact ref/SHA. If the repository has no distinct release
gate, report that topology explicitly and never invent a second gate. A
terminal failure returns control to Root for a bounded fix; this Assignment
never repairs, retries, approves, or mutates external state.
