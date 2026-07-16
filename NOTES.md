# HolyCodex redesign notes

## Baseline

- Repository: `davidbasilefilho/holycodex`.
- Branch: `dev`, created from `main` at `b402bcfc277561b87e38d207eda6e92493bc4f48`.
- Initial worktree: clean.
- Runtime: TypeScript/Bun package with installer source in `src/`, shipped plugin assets in `plugin/`, generated runtime in `plugin/runtime/`, and MCP packages in `packages/`.
- Baseline plugin had 16 skills; three agents; local Git Bash/LSP; remote Context7; unsafe full-access installer defaults; no doctor.

## Approved direction

- Deliver the approved redesign on `dev`.
- Complete repaired `compress` and renamed, attributed `remove-slop` before broader redesign work.
- Use `/caveman lite` for persistent project writing.
- Define the goal automatically after plan approval. The user approved this plan and goal.

## Verification baseline

- A full command transcript was not captured before behavior changes. Baseline measurements were reconstructed from immutable `main`; final behavior is covered by the complete suite. This is a verified evidence limit, not a claimed baseline pass.

## First-milestone research

- Read current `caveman`, `compress`, and `remove-ai-slops` skills completely.
- Read `pols.dev/slop.md` completely on 2026-07-15. It is a frontend-design anti-slop catalogue, not a code-cleanup workflow. Its useful classifications belong in `remove-slop` only when the explicit scope contains user-visible frontend output. They must not force unrelated visual redesign.
- Read oh-my-openagent `remove-ai-slops` at `dec381ed201a1326883db9f42bdb3c2add91b299` from branch `dev`. It adds concrete categories, behavior-locking, safe cleanup order, explicit scope, proof, and reporting. Its OpenCode `deep` agents, task API, and five-wide background batching have no verified Codex equivalent and will not be copied.
- Proposed `remove-slop` design: explicit branch-diff or caller-file scope; behavior lock before edits; categories with keep rules; user review before risky module splitting or compatibility removal; local Codex execution or only bounded independent delegation; targeted proof plus project checks; concise report. Attribution will name both sources and distinguish adapted process from frontend inspiration.

## Architecture and source evidence

- HolyCodex source paths: installer and config ownership in `src/install.ts`, `src/config.ts`, and `src/files.ts`; boot/session instructions in `src/bootstrap.ts`, `src/core-instructions.ts`, and `src/rules-hook.ts`; shipped plugin manifest, MCPs, hooks, agents, skills, and generated runtime under `plugin/`; Git Bash, LSP, daemon, and stdio MCP packages under `packages/`; catalogue, lifecycle, config, hook, protocol, instruction, and version tests under `test/` and package-local tests.
- Codex-supported substitutes: plugin manifests, on-demand skills, TOML agents, command hooks, MCP servers, `AGENTS.md`/rules, native multi-agent sessions, approval and sandbox config, status-line config, and request-user-input. Current official manual documents `status_line` and `context-remaining` but no minimum version.
- Codex limits applied: no OpenCode ACP, council API, companion, multiplexer, model-provider preset switching, background-session manager, reflection lifecycle, phase-reminder loop, or OpenCode task hooks were assumed. Codex root owns decisions and reconciliation; local tools and hooks own deterministic behavior.
- oh-my-opencode-slim source: `alvinunreal/oh-my-opencode-slim` default branch at `7bc7b56856ee693812d87d68615757d4d1c2e218`. Read `README.md`, `LICENSE`, configuration/tool/skill docs, every `src/agents/*` role, all nine `src/skills/*/SKILL.md` files, hook and task-session surfaces, tools, config/model presets, tests, and background-orchestration documentation. Attribution names principal adapted files; preserved upstream MIT notice ships in `plugin/LICENSE-OH-MY-OPENCODE-SLIM-MIT.txt`.

### Upstream skill decisions

| Upstream skill          | Problem and relationship                 | Codex decision                                                                                                 | Context and maintenance effect                    |
| ----------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `clonedeps`             | Fetch dependency source for inspection.  | Reject. Context7, repository tools, and explicit user-authorized clones cover it without a permanent workflow. | Removes network/cache policy and maintenance.     |
| `codemap`               | Generate repository maps for navigation. | Reject as a skill. Explorer, `rg`, LSP symbols, and AST search provide current scoped evidence.                | Avoids generated-map drift and prompt cost.       |
| `deepwork`              | Force prolonged autonomous execution.    | Reject. Goal persistence plus explicit autonomy modes cover duration without OpenCode phase hooks.             | Avoids duplicate state and reminder noise.        |
| `loop-engineering`      | Repeat implementation/review loops.      | Reject. Plan review revises once; project verification supplies bounded proof.                                 | Avoids unbounded token loops.                     |
| `oh-my-opencode-slim`   | Explain upstream system operation.       | Retain only as research and attribution, not a shipped HolyCodex skill.                                        | Avoids loading OpenCode-specific instructions.    |
| `reflect`               | Persist session reflection.              | Reject. Durable user-approved facts belong in repository docs or explicit handoff.                             | Avoids hidden memory and lifecycle hooks.         |
| `simplify`              | Remove unnecessary code.                 | Merge intent into `refactor` and `remove-slop`; preserve separate behavior-lock and structural triggers.       | No redundant routed description.                  |
| `verification-planning` | Define evidence before execution.        | Adapt into `plan`, adversarial `plan-review`, agent packets, and final verification ownership.                 | More depth loads only during planning.            |
| `worktrees`             | Isolate parallel writes.                 | Reject as automatic policy. Codex task worktrees remain host-owned; agents receive non-overlapping paths.      | Avoids repository mutation and cleanup machinery. |

### Upstream agent decisions

| Upstream role             | Decision and Codex mapping                                                                                                 | Model, permission, and use                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| orchestrator              | Merge into Codex root. Root owns intent, architecture, user decisions, task dependencies, reconciliation, and final proof. | User-selected root model; full task-authorized tools; every task.             |
| explorer                  | Keep as bounded repository investigator.                                                                                   | GPT-5.6 Luna low; read-only assigned paths; exact local facts.                |
| librarian                 | Keep as bounded external-source researcher.                                                                                | GPT-5.6 Luna low; read-only primary sources; current external facts.          |
| fixer                     | Rename/adapt to `worker`; implementation only after architecture and scope are fixed.                                      | GPT-5.6 Luna medium; isolated assigned writes; occasional independent slices. |
| designer                  | Merge into root plus `frontend` skill. Visual judgment needs user context and cross-cutting integration.                   | Root model; only frontend tasks.                                              |
| observer                  | Reject. Status observation and verification belong to root and existing tools.                                             | Removes decorative monitoring lane.                                           |
| oracle                    | Reject. Architecture/final judgment cannot be delegated under approved ownership.                                          | Removes expensive duplicate review.                                           |
| councillor/council        | Reject. Codex has no supported equivalent requiring a permanent voting hierarchy.                                          | Avoids multi-model cost and reconciliation.                                   |
| custom/domain/issue roles | Reject from core. Task-specific skills or explicit user configuration provide narrower specialization.                     | Avoids catalogue growth.                                                      |

### Orchestration, hook, and tool decisions

| Upstream system                                   | Decision                                                                                                                                         | Reason and substitute                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| task/session manager and background orchestration | Adapt task identity, dependency, ownership, non-overlapping writes, same-slice session reuse, and return reconciliation into core/agent packets. | Codex supplies sessions; OpenCode background APIs are unsupported. Maximum two concurrent agents remains config-owned.                |
| phase reminders, deepwork, foreground fallback    | Reject.                                                                                                                                          | Goal continuation and concise commentary provide progress without repeated injected reminders.                                        |
| reflection and JSON recovery hooks                | Reject.                                                                                                                                          | Codex/runtime owns protocol recovery; handoff owns explicit resumable context.                                                        |
| skill filtering                                   | Use native on-demand skill discovery and precise descriptions.                                                                                   | Codex progressively loads skill bodies; no custom filter hook needed.                                                                 |
| apply-patch rewrite                               | Reject.                                                                                                                                          | Native `apply_patch` owns edits.                                                                                                      |
| auto-update checker                               | Reject.                                                                                                                                          | Package releases and explicit installs own upgrades; silent background mutation is inappropriate.                                     |
| codemap/smartfetch/clonedeps                      | Reject.                                                                                                                                          | `rg`, LSP, AST search, Context7, GitHub, and browser tools cover scoped lookup.                                                       |
| ast-grep                                          | Keep HolyCodex syntax-aware search skill and tool path.                                                                                          | Useful deterministic structural search without copying upstream downloader design.                                                    |
| rules hooks                                       | Keep and refine existing HolyCodex code.                                                                                                         | Rules remain scoped, ordered, cached, deduplicated, and silent when no context changes.                                               |
| Git Bash and LSP MCPs                             | Keep and strengthen.                                                                                                                             | Codex-native local tools; Windows shim execution, installer, readiness, doctor, agents, tests, and docs fail closed without Git Bash. |
| Context7                                          | Replace hosted authenticated server with latest local `bunx @upstash/context7-mcp`.                                                              | User chose freshness; no login or secret; bounded doctor handshake terminates.                                                        |

## Conflicts and resolutions

- Upstream favors richer agents, background state, hooks, and provider presets; HolyCodex goal favors slim Codex-native orchestration. Supported Codex surfaces and measured routed context win.
- Original `--codex-autonomous` compatibility conflicts with reduced privilege. User chose contained migration plus explicit `--dangerous-codex-autonomous` for former behavior.
- Context7 reproducibility conflicts with freshness. User chose unpinned latest; doctor and explicit diagnostics mitigate resolution/startup drift.
- Prompt compression conflicts with semantic depth. Routed descriptions and agents shrink; `plan-review` grows on demand. Behavioral fixtures, not byte targets, protect meaning.
- `pols.dev/slop.md` addresses visual design while upstream `remove-ai-slops` addresses code cleanup. Visual categories apply only inside matching frontend scope; behavior-locking process applies to explicit code scope.

## User decisions

- `remove-slop` defaults to the branch diff. An explicit user-requested scope overrides the default.

- Approved agent architecture: keep `explorer`, `librarian`, and `worker`. Codex root owns architecture, reconciliation, frontend judgment, and final proof.
- Approved Context7 policy: follow latest through unpinned `bunx @upstash/context7-mcp`. Freshness wins over deterministic package resolution; doctor detects package and startup failures.
- Approved autonomy migration: `--codex-autonomous` becomes approval-free but workspace-contained. New `--dangerous-codex-autonomous` provides former unrestricted behavior. Installer output and README warn about the change; unrestricted access is never inferred.
- Approved final treatment: keep `NOTES.md` in the repository as durable redesign evidence.

## Implementation progress

- Rewrote `plugin/skills/compress/SKILL.md`: semantic compression now preserves distinctions, exceptions, exact values, safety gates, evidence, and stop conditions; combined use renders through `/caveman lite` after semantic compression.
- Added `compress` contract coverage in `test/instruction-contracts.test.ts`.
- Installed locked dependencies with `bun install --frozen-lockfile`.
- Replaced `remove-ai-slops` with `remove-slop` across the shipped skill catalogue and adjacent routing.
- `remove-slop` defaults to the branch diff, honors explicit scope, locks observable behavior, preserves boundary and compatibility behavior, skips uncertain changes, and records upstream attribution.
- Added realistic instruction contracts for scope, behavior lock, exclusions, ordering, user gates, proof, and attribution.
- Made agent-model catalogue checks tolerate both LF and CRLF without weakening model assertions.
- Studied `oh-my-opencode-slim` at pinned commit `7bc7b56856ee693812d87d68615757d4d1c2e218`. Retained bounded specialist roles, explicit job packets, non-overlapping writes, task identity, session reuse, and verification planning. Rejected OpenCode-only ACP, council, companion, reflection, multiplexer, background-session, and hook machinery.
- Kept three agents. Codex already owns orchestration and frontend/visual work; more agents would duplicate skills and raise prompt/integration cost.
- Added safe default, sandboxed autonomous, and explicitly dangerous autonomy modes; preserved explicit root model/effort; defaulted absent values to Terra medium.
- Added managed `status_line` context visibility, two-thread cap, request-user-input feature merge, and workspace network access without duplicate TOML tables.
- Replaced remote Context7 with local unauthenticated `bunx @upstash/context7-mcp`.
- Added readable/JSON `holycodex doctor` with distinct Bun, bunx, JSON, obsolete remote/auth, package, startup, and healthy states.
- Enforced Git Bash on native Windows with no PowerShell/cmd fallback.
- Expanded plan-review across constraints, change surfaces, risk, recovery, ordered proof, and stop conditions while retaining prompt budgets.

## Current verification

- Focused installer suite: 18 tests passed.
- Final `bunx vp build && bunx vp test && bun scripts/version.mjs check`: build passed; 31 files, 143 tests passed, 1 skipped; versions match 0.5.3.
- Installed smoke test: `holycodex doctor --json` returned `healthy` after a real local Context7 MCP handshake.

## Compatibility evidence

- Refreshed the official Codex manual on 2026-07-15. Its configuration reference documents root `status_line`, lists `context-remaining`, and states the default list is `["model-with-reasoning", "context-remaining", "current-dir"]`. The public manual gives no minimum compatible Codex version. Doctor therefore reports configured/currently documented support but does not claim that an arbitrary installed version is proven compatible.
- Git Bash resolution uses an explicit override before the default `C:\\Program Files\\Git\\bin\\bash.exe` and other Git-for-Windows discovery paths. Native Windows has no PowerShell or cmd fallback.

## Measurements

All sizes are bytes unless stated. Baseline is `main` at `b402bcfc277561b87e38d207eda6e92493bc4f48`; after is the current `dev` worktree before final cleanup.

| Surface                               |                     Before |                     After | Result                                                                          |
| ------------------------------------- | -------------------------: | ------------------------: | ------------------------------------------------------------------------------- |
| Core instructions source              |                      2,234 |                     2,432 | +198 for mandatory tool-registry, Git Bash, ownership, packet, and model rules. |
| Three agent TOMLs                     |                      5,789 |                     5,543 | -246 while retaining packet and return contracts.                               |
| Skill descriptions                    |                      5,196 |                     4,835 | -361 routed by default.                                                         |
| Skill bodies                          |                     20,971 |                    21,973 | +1,002 loaded on demand; adversarial plan review accounts for the increase.     |
| All skill descriptions and bodies     |                     26,167 |                    26,808 | +641; routed descriptions shrank while selected workflow depth grew.            |
| `compress`                            |                      1,497 |                       998 | -499 with fixture-backed semantic preservation.                                 |
| old `remove-ai-slops` / `remove-slop` |                      1,223 |                     1,252 | +29 for explicit behavior lock, scope, proof, and attribution.                  |
| `plan-review`                         |                      1,291 |                     2,402 | +1,111 for the requested adversarial taxonomy and one-pass repair.              |
| Hook configuration                    |                      1,497 |                     1,497 | No added injection surface. Silent/deduplicated behavior remains code-owned.    |
| Generated runtime                     | not separately packed here | 161,595 total build bytes | Eight generated chunks, including shared Git Bash resolution.                   |
| Packed tarball                        |                    235,975 |                   279,293 | +43,318 for doctor, fixtures, attribution, and expanded runtime.                |
| Unpacked package                      |                    772,952 |                   936,315 | +163,363.                                                                       |
| Package files                         |                         83 |                        92 | +9.                                                                             |
| Tracked plus intended new files       |                        213 |                       223 | +10.                                                                            |
| Root dependencies                     |           0 runtime, 5 dev |          0 runtime, 5 dev | No dependency growth. Four workspaces remain.                                   |
| Repository archive/worktree payload   |                  1,361,920 |                 1,392,640 | +30,720 excluding `.git` and dependencies.                                      |

- Task packets are not duplicated into runtime objects: one compressed contract lives in core instructions and each agent prompt. Returns are bounded by exact requested format and must contain evidence, criteria status, and blocker or residual risk. Agent prompt reduction is the measurable packet/return overhead improvement.
- Token trade-off is intentional: default routed descriptions and agent prompts shrink; `plan-review` grows only when selected. Semantic-loss fixtures protect compression, exact values, exceptions, approved decisions, and behavior locks.

## Cleanup audit

- Expanded `.gitignore` for dependency/build output, coverage, archives, logs, temp files, editor state, OS metadata, and local environment files while preserving `.env.example`.
- Untracked files are all intended source, tests, fixtures, license, doctor, or working notes. Ignored output is limited to dependencies, generated runtime, and the existing LSP daemon build.
- Found and removed two `cmd.exe` command-shim launch paths in the LSP process layer. Windows `.cmd` and `.bat` language-server shims now launch through resolved Git Bash or fail closed. Direct `taskkill` remains a process utility, not a shell fallback.
- No runtime dependency was added. No cache, generated runtime, migration, license, fixture, or behavior-lock test was deleted.
- Refreshed index stat data for 123 zero-diff files after the LF formatter exposed Windows `core.autocrlf` status noise. No content or staged change resulted. Final status contains 25 logical tracked changes plus 10 intended new files.

## Final verification run

- `bunx vp check`: all 183 files formatted; no warnings or lint errors in 118 checked files.
- `bunx tsc --noEmit`: passed strict TypeScript.
- `bun run test`: build passed; 34 files passed; 163 tests passed; one platform-specific test skipped.
- `bun run version:check`: all package and runtime versions match `0.5.3`.
- `npm pack --dry-run --ignore-scripts --json`: 92 files, 279,293-byte tarball, 936,315 bytes unpacked. Package includes generated CLI runtime, shared Git Bash resolver, `remove-slop`, attribution, and the oh-my-opencode-slim MIT notice; obsolete `remove-ai-slops` is absent.
