---
name: tdd
description: Use public-seam red-green-refactor for requested TDD, regression, or integration tests.
---

# TDD

Find established seam before asking user. Ask only if materially different contracts remain.

## Slice

1. Pick one observable outcome.
2. Red: test public seam. Run it. Confirm failure matches missing behavior, not setup error.
3. Green: minimum production code. No second case yet.
4. Refactor only with green test.
5. Repeat vertical slice.

Given/When/Then: known fixture; one action; only observable result caused by action.

Reject private-method tests, tautology, snapshot abuse, broad mocking, sleeps, wall-clock dependence, implementation-coupled assertions, deleted failing tests.

Test doubles order: real object; in-memory fake; test container or sandbox; wire fake; narrow mock last. Fake must honor real contract.

Fixtures deterministic and isolated. Coverage proportional to risk. Run smallest test during loop; broader gates at completion. See `tests.md` and `mocking.md` only when needed.
