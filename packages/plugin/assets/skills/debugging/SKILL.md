---
name: debugging
description: Use for a reproducible crash, wrong result, regression, hang, race, leak, or slowdown.
---

Reproduce the defect before changing code. Capture the smallest failing input
and trace, identify the evidence-backed cause, make the narrow repair, and prove
the regression is gone. Escalate competing causes or a material redesign.

Root dispatches this procedure to the canonical `Worker.debugging` route as a
bounded repair Assignment. Root does not reproduce, repair, or test the defect
locally; material redesign returns to Root for a new decision.
