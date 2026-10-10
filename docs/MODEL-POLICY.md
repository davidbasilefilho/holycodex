# Native model policy

HolyCodex model selection, resolved model metadata, and canonical instructions are separate runtime
seams. The typed `holycodex-policy` registry owns Root/specialist allocation and Role.task reasoning
effort. The models manager owns the final context metadata overlay: provider catalog capabilities
are resolved first, ordinary config overrides are applied, then the HolyCodex context profile is
applied in `with_config_overrides`, including after cache and remote catalog lookup. Core owns
prompt selection because it has both the actual session source and the allocated model.

For `gpt-6.1-sol` and `gpt-6-luna`, the normal raw window is 372,000 tokens. A catalog maximum
above that value is preserved; a lower maximum or explicit lower `model_context_window` remains
effective. Native policy derives the compaction limit from this window and the provider's usable
context percentage, retaining its safety margin. Codex additionally caps effective compaction at
90% of the raw window: a 372K profile currently compacts by 334,800 tokens. Provider maximum
metadata survives, and no compaction threshold from the former 272K profile is retained.

Session bootstrap allocates through the typed policy against the active catalog, validates exact
required model availability, and rejects a conflicting configured model. Root uses `gpt-6.1-sol`;
all specialists use `gpt-6-luna`. Under the default profile, Root uses medium effort and
every specialist Role.task uses high effort. The low and high profiles retain their route-specific
effort mappings. Compatibility controller spawns retain their already registry-validated prepared
effort when their agent role is `default`. Upstream review, compaction and internal safety/memory
sessions retain their separate allocation contracts.

The service tier is a separate optional setting. `[holycodex].service_tier` defaults to unset;
the active provider/host configuration remains authoritative, so this policy does not claim an
explicit Standard tier was selected.
Enabled HolyCodex sessions select the native local V2 tool surface even on restore; no hosted
Responses multi-agent parameter is introduced.

At session startup and resume, Core's `native_prompt_role` and `native_model_instructions` in
`holycodex.rs` resolve the canonical base from the actual session source and allocated model.
`Session::new` applies it to native Root and bound specialist sessions before composing the base,
protecting that base from saved session text and user instruction overrides. Core clears catalog
persistent instructions for those native sessions. The request builder checks the same role/model
pairing before applying the canonical policy instructions as defense in depth. Internal, review,
compaction, memory, guardian, and other non-HolyCodex subagent sessions keep their own upstream
prompts and persistent instructions, even when they use a HolyCodex model slug. The models manager
remains source-neutral: it preserves catalog/config instruction templates, variables, and persistent
instructions while applying context metadata only. Assignment fragments remain separate
developer/user context supplied by the controller. Step-settings updates revalidate required
availability and resolve current catalog metadata rather than retaining stale HolyCodex capacity
after a refresh.

The layered `[holycodex]` table is registered in `codex-config` and its generated schema.
Production strict-config validation accepts the supported fields and rejects unknown fields.
The effective table is read without modifying any config file.

The CLI and compatibility executable must remain one runtime. A branding or executable alias must
not change the product identity sent to the service. Core request originators, inherited/resumed
thread origins, and session service branding are pinned to HolyCodex. Login requests still need
the matching default originator at `codex-login`'s `default_client` boundary.
Sign-in registration and its persisted client identity likewise belong to that authentication
boundary. The model provider should continue to use provider-resolved HTTP Responses/SSE transport;
account scopes and capabilities must come from the resolved auth and provider metadata, never from
the binary name or assumed desktop entitlements.

## Host integration preferences and permissions

The `browser_use`, `computer_use`, and `sites` values under
`[holycodex.capabilities]` are retained for configuration compatibility. They
are not independent runtime security controls: changing them does not disable
host tools. Actual host, MCP, sandbox, and confirmation permissions remain
authoritative and are never bypassed by these preferences.

The recognized browser/computer integrations share a transport without
trusted per-operation capability metadata. HolyCodex deliberately preserves
those host-provided functions rather than blocking browser access whenever
`computer_use` is false. Independent browser/computer enforcement is deferred
until the host can provide reliable operation-level capabilities. Tool names
or descriptions alone are not used as a substitute for that metadata.

Use the host's actual integration permissions when access must be disabled.
Do not rely on the default `computer_use = false` as a security boundary.
