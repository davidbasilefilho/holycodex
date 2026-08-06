# Architecture

HolyCodex uses model-authored dynamic workflows as its primary orchestration system. Root owns user intent, scope, architecture, material decisions, integration, final judgment, and verification. For substantive requests, Root writes one or more task-specific JavaScript workflows instead of selecting a fixed route or task graph.

## Workflow layers

`packages/workflow-runtime` evaluates workflow JavaScript in a capability-denied QuickJS WebAssembly runtime. Scripts receive only `agent()`, `pipeline()`, structured `args`, metadata support, and ordinary inert JavaScript values. They cannot access the filesystem, shell, processes, environment variables, networking, imports, Codex configuration, credentials, or unrestricted host globals.

The runtime host validates every boundary and enforces the active plan before dispatch. Codex App Server is the supported programmatic bridge, so each `agent()` call starts an independent thread with a permitted catalog route, low verbosity, and the selected service tier. Task-child visibility does not determine orchestration: workflows remain primary for substantive paid-plan work, direct Root execution is valid for small work, and native subagents are fallback-only when the workflow runtime is unavailable or cannot perform the operation. Codex remains authoritative for sandboxing, approvals, tool restrictions, skills, plugins, trust, and project boundaries. Interactive approvals are forwarded only on surfaces that support them; non-interactive runs fail closed when fresh approval is required. Workflow execution has no wall-clock deadline and ends through completion, cancellation, quota exhaustion, bounded-operation failure, or inactivity protection. Call and concurrency quotas, fan-out, retries, loop limits, memory, stack, and script size remain bounded.

Workflow state is persisted atomically outside the conversation context. A run journal contains the generated script, public metadata, phase state, completed results, aggregate usage, errors, and cancellation state. It never contains hidden reasoning, system prompts, credentials, or unrestricted child transcripts. Deterministic replay reuses a completed call only when its script identity, structured input, agent options, project identity, trust state, and active plan remain valid.

## Package ownership

`packages/cli` owns parsing, managed configuration, workflow lifecycle commands, doctor, transactional installation, and prompt composition. `packages/plugin` is the published static payload. `packages/workflow-runtime` owns script isolation and orchestration primitives. `packages/runtime-core` owns neutral bounded child-process primitives. `packages/lsp-core` and `packages/lsp-daemon` own language-server behavior and transport. `packages/git-bash` owns Windows resolution and launch.

`packages/cli/src/catalog.ts` is authoritative for models, stage-aware permitted routes, reasoning effort, service tiers, soft target calls, hard workflow quotas, projected usage, skills, agents, historical migration recognition, and generated runtime expectations. Documentation and tests mirror that contract.

HolyCodex installs no MCP server.
