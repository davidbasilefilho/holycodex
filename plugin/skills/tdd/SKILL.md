---
name: tdd
description: Public-seam vertical red-green-refactor development.
---

Discover established seam before asking. Test observable behavior. One vertical slice: red must fail for intended reason; minimum green; refactor. Reject private tests, tautology, snapshot abuse, broad mocks, sleeps, implementation assertions. Prefer real object, fake, test container or wire fake, then narrow mock. Deterministic fixtures. Coverage proportional to change. Targeted test in loop; broader gates at end.
