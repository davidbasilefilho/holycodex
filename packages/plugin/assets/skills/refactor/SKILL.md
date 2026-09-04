---
name: refactor
description: Use when Root has decided one seam needs restructuring; preserve behavior, ownership, and interfaces.
---

Restructure only the decided seam. Trace its callers before changing a shared
root cause, preserve public behavior and interfaces, and keep the smallest
cohesive change. Discover the repository's own validation commands and run the
smallest relevant behavior-locked check first; broaden when the changed
boundary or release gate requires it. Inspect changed files and remove
incidental generated output before stopping.
