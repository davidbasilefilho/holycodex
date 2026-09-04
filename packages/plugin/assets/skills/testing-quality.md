# Testing quality

Use this reference when Root, Worker, or Reviewer evaluates a test for a
requested change.

Owner: Worker or Reviewer within the assigned test surface. Boundary: protect
stable behavior, contracts, invariants, safety properties, compatibility
guarantees, and meaningful failure modes. Prefer observable and typed or
public boundaries while leaving implementation choices free.

Before adding a regression or package-verification test, identify:

1. the stable behavior it protects;
2. the real regression it catches;
3. why a less brittle boundary cannot protect it.

Remove or rewrite tests that freeze incidental counts, inventories, internal
paths, prompt or skill sizes, exact non-contract wording, irrelevant call order,
deleted names, broad repository shape, or one implementation strategy. Avoid
large internal snapshots and static source inspection when a behavior check
exists. Package-verification tests should consume the shipped artifact through
one supported outer boundary with minimal realistic setup, proving a meaningful
artifact behavior without duplicating the suite or crawling inventories.

Use proportional proof. A test that constrains more design than meaningful regression risk should not exist.

Completion: each retained test names the stable behavior and regression it
protects, and the chosen boundary is no more brittle than necessary.
