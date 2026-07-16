## Reviewed executable plan

1. Create and switch to `dev` from current `main`; preserve existing `dev` work if present. Create root `NOTES.md` before deep study and record baseline branch, commit, repository state, architecture, constraints, and command results.  
   Proof: `git status`, branch ancestry, and an initialized concise `NOTES.md`.

2. Establish a reproducible baseline: inspect all source, generated runtime, plugin assets, tests, package contents, installer lifecycle, current config mutations, hooks, agents, skills, licenses, and token-size measurements. Run the existing checks before changing behavior.  
   Proof: baseline results and measurements recorded in `NOTES.md`.

3. Complete the mandatory first milestone before broader redesign:
   - Read current `caveman` and `compress` fully.
   - Rewrite `plugin/skills/compress/SKILL.md` to own semantic compression.
   - Rename `plugin/skills/remove-ai-slops` to `remove-slop` across source, generated assets, catalogue, routing, tests, docs, packaging, and migration behavior.
   - Study `pols.dev/slop.md` and the specified oh-my-openagent skill at pinned commits; merge their useful design into the new skill with attribution.
   - Add behavioral fixtures for compression, grammar, preservation, deduplication, exceptions, and `/caveman lite` compliance.  
   Proof: targeted tests pass; generated runtime and catalogue contain only the new public name except justified historical attribution.

4. Study the complete current default branch of `oh-my-opencode-slim` and relevant oh-my-openagent sources, recording exact commits, licenses, component relationships, Codex equivalents, and unsupported OpenCode mechanics. Map each candidate skill, agent, hook, rule, and workflow to retain/adapt/merge/move/reject decisions with token and maintenance costs.  
   Proof: `NOTES.md` contains an evidence-backed comparison matrix and attribution inventory.

5. Present the first decision checkpoint: current architecture and weaknesses, proposed `remove-slop`, and the skill-migration table. Obtain approval for meaningful choices before broad migration. Continue only non-conflicting research while awaiting a response.  
   Proof: user decisions and consequences recorded in `NOTES.md`.

6. Redesign planning behavior after studying current and upstream planning, review, goal, and execution flows. Update `plan`, `plan-review`, and related fixtures so they enforce one initial plan, one adversarial review, approval, optional bounded goal, and no review loop.  
   Proof: realistic behavioral tests cover missing requirements, unsafe parallelism, overlapping writes, unsupported assumptions, migration/package omissions, preservation of approvals, and one-pass termination.

7. Design and present the proposed final agent/model architecture. Retain, merge, replace, or remove agents only when model, isolation, permissions, cost, or task shape justify them. Preserve root ownership of intent, architecture, integration, and final verification; use bounded specialist work only where it has measured value.  
   Proof: approved agent matrix, updated TOML definitions, routing tests, and prompt-cost measurements.

8. Design and present orchestration, hooks, and rules based on verified Codex support. Keep deterministic scoped rules available before use, silent hooks when unchanged, Git Bash mandatory on Windows, durable state only where it improves recovery, and no unsupported OpenCode background/session mechanisms.  
   Proof: supported hook schema, deterministic rules tests, Windows-shell enforcement tests, and documented Codex limitations.

9. Redesign install/config/CLI behavior in `src/config.ts`, `src/install.ts`, `src/cli.ts`, generated runtime, docs, and lifecycle tests:
   - Default and `--no-codex-autonomous`: `on-request`, `workspace-write`, network enabled.
   - `--codex-autonomous`: `never`, `workspace-write`, network enabled.
   - `--dangerous-codex-autonomous`: `never`, `danger-full-access`, explicit warning only.
   - Preserve explicit settings safely; define and obtain approval for ambiguous migration from the old dangerous behavior.
   - Default root model to `gpt-5.6-terra` with medium effort only when unspecified; retain concurrent-thread limit two.
   - Safely merge `default_mode_request_user_input = true`.  
   Proof: parser, migration, conflict, idempotency, preservation, help, cleanup, and generated-runtime tests pass.

10. Verify current Codex configuration support from official sources before implementing context-window UI visibility. Add only a confirmed durable setting; otherwise present supported alternatives for approval.  
    Proof: source-backed compatibility record, config-preservation tests, doctor reporting, and documentation.

11. Replace remote Context7 configuration with local `bunx @upstash/context7-mcp`, based on verified current package and Codex MCP schemas. Add Bun/`bunx` detection, bounded terminating health checks, no-auth migration and repair, and precise diagnostics without secrets.  
    Proof: fresh install, upgrade, malformed config, obsolete auth, missing executable, package-resolution, startup, preservation, and no-persistent-server tests.

12. Implement `holycodex doctor` with text and `--json` output. Cover installed/runtime integrity, plugin assets, skills, agents, model config, user-input feature, context-window support, autonomy mode, dangerous-mode warning, MCPs, Context7, LSP applicability, generated consistency, package integrity, and Git Bash readiness.  
    Proof: doctor fixture matrix verifies actionable, non-secret diagnostics and all requested distinctions.

13. After approval of the architecture, compress and reconcile all core instructions, agent prompts, skill descriptions/bodies, hook messages, rules, docs, and catalogue metadata. Move deterministic behavior into code where evidence supports it; preserve constraints, user control, safety, exact values, accessibility/motion requirements, and behavior not already code-enforced.  
    Proof: behavioral routing and instruction-contract tests replace brittle wording-only assertions where feasible; before/after size and semantic-preservation measurements are recorded.

14. Regenerate all shipped runtime and derived files, update `README.md`, CLI help, migration guidance, package contents, `THIRD-PARTY-NOTICES.md`, focused attribution files, and licensing notices.  
    Proof: build output matches source, package inspection succeeds, version checks pass, and required notices identify source commits and license terms.

15. Run focused checks throughout, then the complete formatting, strict type, build, test, lifecycle, migration, doctor, package, generated-file, and version suites. Record results and remaining verified limits in `NOTES.md`.  
    Proof: all required checks pass or any external limitation is explicitly reproduced and documented.

16. Perform final repository cleanup only after the redesign is verified. Remove only proven stale, duplicated, superseded, or non-shipped artifacts; ask before removing public, compatibility, migration, or plausibly user-dependent behavior. Correct `.gitignore` without hiding required assets.  
    Proof: tracked/untracked audit, focused cleanup tests, full suite rerun, and recorded deletion rationale.

17. Present final treatment options for `NOTES.md`: retain it as project history, move durable findings into permanent documentation then remove it, or keep it untracked. Apply the selected outcome and provide the required concise completion report.  
    Proof: user decision is recorded and the chosen repository state is verified.

Approval is required before implementation.
