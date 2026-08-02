---
name: security-research
description: Use when authorized work needs repository security review, threat analysis, vulnerability validation, or attack-path/exploitability proof; do not use for generic review, ordinary debugging, unsupported hardening, or real-system attacks. Produces evidence-calibrated findings and minimum fixes.
---

# Security Research

Main agent owns scope, threat surface, dedupe, proof, severity, report. No Team Mode. At most two independent lanes when useful: `explorer` for one internal surface, `librarian` for named standards/dependency facts. No duplicate hunters, recursion, review loop, or full-history fork.

- Name repo/diff/path/release/threat surface. Map entry points, attacker input, trust boundaries, assets, sinks, privilege transitions.
- No severity without reachable attack path. High/critical needs safe local PoC or decisive static proof with concrete preconditions/impact.
- CWE classifies weakness; severity measures exploitability/impact. Generic hardening is not a finding.
- Never attack real/third-party systems; use local fixtures, toy payloads, dry runs, or static proof.

1. Baseline scope, branch/diff, sensitive paths, tests, constraints.
2. Map attacker capability/input, boundary, sink, asset.
3. Record candidates: title, path/function, attack path, impact, CWE candidate, evidence, safe proof.
4. Deduplicate by root cause/attack path.
5. Reproduce, falsify, or downgrade strongest candidate; record exact command/output.
6. Calibrate severity from proven preconditions, reachability, privilege, user action, scope, confidentiality, integrity, availability.
7. Give minimum fix and public-seam regression test.

Report `PASS`, `PASS WITH FINDINGS`, or `BLOCK`. Each finding gives severity, title, CWE, path/function, attacker capability/path, proof, impact, minimum fix, regression check. List downgraded/rejected candidates with reasons; end with untested surfaces and why. Use CWE, OWASP WSTG/ASVS, or CVSS v4 only when relevant with exact sources; score every metric before precise CVSS.
