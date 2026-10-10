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
