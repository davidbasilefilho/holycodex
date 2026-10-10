# Public mergeability review cases

These human-readable cases keep review expectations concrete. They are guidance examples, not a
model grader or a reproduction of any private evaluation system.

1. **Passing checks, unnecessary abstraction.** A focused change passes its tests but adds a new
   generic framework used by one call site, with no demonstrated extension need. Review the
   behavior and maintenance cost; ask for a simpler cohesive implementation or evidence that the
   abstraction is needed. Passing tests alone does not resolve the maintainability concern.
2. **Weak regression check.** A test passes because it checks that a result exists but never checks
   the behavior that previously failed. Treat missing regression evidence as a blocker and state
   which behavior the test must assert. Do not accept a weakened or tailored check.
3. **Failure already present on the base.** The same relevant check fails on the unchanged base and
   the candidate. Report the command and comparison evidence, distinguish the baseline failure from
   regressions introduced by the change, and do not claim that the candidate fixed it.
4. **Optional style preference.** Behavior, integration, error paths, compatibility, and meaningful
   checks are sound; one reviewer prefers a different but locally acceptable formatting choice.
   Report it as optional feedback, not a merge blocker. Line count alone is not evidence of quality.

5. **Functional success, architectural regression.** A feature works in isolation but duplicates an
   existing abstraction and bypasses its error or compatibility contract. Trace affected callers,
   use relevant project conventions and maintainer precedents, and request a cohesive integration.
   Distinguish a demonstrated maintenance burden from a personal design preference.
6. **Competing maintainer precedents.** Earlier accepted changes use different patterns. Identify
   the closest applicable precedent and explain its constraints; do not treat an unrelated example
   as a universal rule. Escalate a material unresolved product decision to Root with alternatives.
7. **Build success, broken interface.** A UI change builds and its snapshots match but a narrow
   viewport clips the primary action or keyboard navigation cannot reach it. Worker.visual must
   exercise and repair the actual rendered state; an independent Reviewer.visual verifies it.
   Record the viewport, interaction, visible result, and any blocked inspection.
8. **Independent review after a fix.** The implementer has useful retained context but must not
   become the independent reviewer of that change. Reuse a compatible independent specialist or
   create one. If the reviewer implements a fix, arrange independent review of that fix before
   treating the review as complete.
9. **Different owner, different permissions.** A new owner asks for work in their project; a
   retained example describes another owner's preferred tools and release approval. Use the current
   owner's applicable preferences and permissions. Keep durable instructions in US English, honor
   the requested language for the deliverable, and do not treat the example as authorization.
10. **Existing branch convention.** A target repository documents `feature/<topic>` branches and
    PRs against `develop`. Preserve that convention and the valid active branch. Do not replace it
    with a release branch or force the repository into HolyCodex's PR stack layout. Verify the
    actual base, checks, and workflow triggers before publishing authorized work.
11. **Release fallback in a mature project.** A project preparing version `2.4.0-rc.1` has no
    applicable branch convention. If its workflow triggers permit an authorized review branch,
    `release/v2.4.0-rc.1/<semantic-change>` is an applicable release-work fallback. Preserve the
    version and suffix; do not run HolyCodex's zero-major validator against this other project.
    A matching name does not authorize publication or establish merge readiness.

These are evaluation scenarios, not observed model results. A behavioral evaluation must record the
actual task, model/profile, session provenance, tool trace, artifact, and reviewer outcome. Prompt
substring assertions establish packaging only; scripted route and lifecycle tests establish only
the deterministic controller contracts they exercise.
