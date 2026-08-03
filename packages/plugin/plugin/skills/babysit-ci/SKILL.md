---
name: babysit-ci
description: Use when a push, tag, dispatch or rerun, release, or deployment triggers CI/CD, or an active CI/CD run needs monitoring; do not use for local tests or status alone. Produces green CI/CD or a precise blocker.
---

# Babysit CI

Track run/job, SHA, ref/tag, environment, deployment.

1. Map checks, triggers, release/tag rules, runs.
2. Watch relevant runs to terminal state with wait tools; report changes only.
3. Diagnose logs; classify defect, flake, auth, outage. Prove cause; never retry an unchanged deterministic failure.
4. Fix root cause; preserve user work; run permitted checks.
5. Retrigger by fix push, transient rerun, workflow dispatch, or tag. Ask immediately before every push, publication/deployment, or tag creation; broad requests and prior approval do not waive confirmation. Other external/destructive actions require authority. Never move/delete tags or use empty trigger commits without approval. Verify new run SHA/ref.
6. Watch downstream CI/CD. For binary deliverables only, inspect integrity, version, contents, signatures, installability, smoke behavior. Never manually inspect registry outputs, including npm packages; verify registry status/metadata. Binary defects require new artifacts.
7. Repeat with new evidence/fixes. Stop at terminal-green required CI/CD plus clean artifacts/deployments, or a precise authority/external/repeated-failure blocker.
