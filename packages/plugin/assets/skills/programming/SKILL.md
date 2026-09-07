---
name: programming
description: Use when Root has decided a bounded implementation seam with known acceptance behavior.
---

Implement only the decided seam. Inspect its callers and typed boundaries
before implementation, and add proof at the least brittle observable boundary
when the acceptance behavior requires it.

Root dispatches this procedure through the native `Worker.implementation`,
`Worker.integration`, or `Worker.mechanical` route selected by the Assignment.
Root does not implement or test the seam locally.
