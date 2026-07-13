---
name: security-research
description: Use when an authorized task needs repository security review, threat analysis, vulnerability validation, or attack-path and exploitability proof; do not use for generic review, ordinary debugging, unsupported hardening claims, or real-system attacks. Produces evidence-calibrated findings and minimum fixes; unlike debugging it evaluates attacker reachability and impact.
---

# Security Research

Main agent owns scope, threat surface, dedupe, proof, severity, report. No Team Mode. At most two independent lanes when useful: `explorer` for one internal surface; `librarian` for named standards or dependency facts. No duplicate hunters, recursive delegation, reviewer loop, or full-history fork.

## Rules

- Name target: repo, diff, path, release, or threat surface.
- Map entry points, attacker input, trust boundaries, sensitive assets, sinks, privilege transitions.
- No severity without reachable attack path.
- High or critical needs safe local PoC or decisive static proof plus concrete preconditions and impact.
- CWE classifies weakness. Severity measures exploitability and impact. Keep separate.
- Generic hardening is not finding.
- Never attack real or third-party systems. Use local fixture, toy payload, dry run, or static proof.

## Flow

1. Baseline: scope, branch/diff, sensitive paths, tests, constraints.
2. Threat surface: attacker capability, controlled input, boundary, sink, asset.
3. Candidates: title, path/function, attack path, impact, CWE candidate, evidence, safe proof idea.
4. Deduplicate by root cause and attack path.
5. Validate strongest candidate. Reproduce, falsify, or downgrade. Record exact command and observed output.
6. Calibrate severity from proven preconditions, reachability, privilege, user action, scope, confidentiality, integrity, availability.
7. Give minimum fix and public-seam regression test.

## Report

Lead with `PASS`, `PASS WITH FINDINGS`, or `BLOCK`.

For each surviving finding: severity, title, CWE, affected path/function, attacker capability, attack path, proof, impact, minimum fix, regression check.

Also list downgraded and rejected candidates with reason. End with residual risk: untested surfaces and why.

Use CWE, OWASP WSTG/ASVS, and CVSS v4 only when relevant. Cite exact source. Do not claim precise CVSS score without scoring every metric.
