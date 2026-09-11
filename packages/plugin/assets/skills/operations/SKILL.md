---
name: operations
description: Use for a Worker.operations exact-ref/SHA observation Assignment.
---

Load [babysit-ci](../babysit-ci/SKILL.md) before observing the supplied exact ref
and SHA. Return the required terminal gate evidence and any unavailable or
ambiguous blocker within the Assignment's observation-only authority. Include
target-branch or pull-request mergeability evidence when the repository or
provider exposes it; green CI alone does not prove mergeability.
