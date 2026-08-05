# Architecture

HolyCodex uses model-authored dynamic workflows as its primary orchestration system. Root owns user intent, scope, architecture, material decisions, integration, final judgment, and verification. For substantive requests, Root writes one or more task-specific JavaScript workflows instead of selecting a fixed route or task graph.

## Workflow layers

`packages/workflow-runtime` evaluates workflow JavaScript in a capability-denied QuickJS WebAssembly runtime. Scripts receive only `agent()`, `pipeline()`, structured `args`, metadata support, and ordinary inert JavaScript values. They cannot access the filesystem, shell, processes, environment variables, networking, imports, Codex configuration, credentials, or unrestricted host globals.

The runtime host validates every boundary and enforces the active plan before dispatch. Codex App Server is the supported agent bridge: each `agent()` call starts an isolated Codex thread with the catalog-selected model, reasoning effort, low verbosity, and service tier. Codex remains authoritative for sandboxing, approvals, tool restrictions, skills, plugins, trust, and project boundaries. Interactive approvals are forwarded only on surfaces that support them; non-interactive runs fail closed when fresh approval is required.

Workflow state is persisted atomically outside the conversation context. A run journal contains the generated script, public metadata, phase state, completed results, aggregate usage, errors, and cancellation state. It never contains hidden reasoning, system prompts, credentials, or unrestricted child transcripts. Deterministic replay reuses a completed call only when its script identity, structured input, agent options, project identity, trust state, and active plan remain valid.

## Package ownership

`packages/cli` owns parsing, managed configuration, workflow lifecycle commands, doctor, transactional installation, and prompt composition. `packages/plugin` is the published static payload. `packages/workflow-runtime` owns script isolation and orchestration primitives. `packages/runtime-core` owns neutral bounded child-process primitives. `packages/lsp-core` and `packages/lsp-daemon` own language-server behavior and transport. `packages/git-bash` owns Windows resolution and launch.

`packages/cli/src/catalog.ts` is authoritative for models, reasoning effort, Fast service tier, workflow quotas, skills, agents, historical migration recognition, and generated runtime expectations. Documentation and tests mirror that contract.

HolyCodex installs no MCP server.
