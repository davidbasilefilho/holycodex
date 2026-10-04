# Native model policy

HolyCodex model selection and resolved model metadata are separate runtime seams. The typed
`holycodex-policy` registry owns Root/specialist allocation and Role.task reasoning effort. The
models manager owns the final metadata overlay: provider catalog capabilities are resolved first,
ordinary config overrides are applied, then the HolyCodex context profile is applied in
`with_config_overrides`, which is also used after cache and remote catalog lookup.

For `gpt-6.1-sol` and `gpt-6-luna`, the normal raw window is 372,000 tokens. A catalog maximum
above that value is preserved; a lower maximum or explicit lower `model_context_window` remains
effective. Native policy derives the compaction limit from this window and the provider's usable
context percentage, retaining its safety margin. Codex additionally caps effective compaction at
90% of the raw window: a 372K profile currently compacts by 334,800 tokens. Provider maximum
metadata survives, and no compaction threshold from the former 272K profile is retained.

Session bootstrap allocates through the typed policy against the active catalog, validates exact
required model availability, and rejects a conflicting configured model. Root effort follows
`[holycodex].profile` (`low`, `default`, or `high`); the default Root request uses medium effort.
Specialist Role.task effort follows the same registry; compatibility controller spawns retain
their already registry-validated prepared effort when their agent role is `default`. Upstream
review, compaction and internal safety/memory sessions retain their separate allocation contracts.
Enabled HolyCodex sessions select the native local V2 tool surface even on restore; no hosted
Responses multi-agent parameter is introduced.

The models manager replaces the base template with the policy crate's embedded Root or shared
specialist asset after ordinary overrides. Session startup and resume use that resolved base;
saved session instructions and user instruction overrides cannot replace it. Request construction
also protects the canonical base and rejects fallback metadata before creating an inference
request. Assignment fragments remain separate developer/user context supplied by the controller.
Step-settings updates revalidate required availability and resolve current catalog metadata rather
than retaining stale HolyCodex capacity after a refresh.

The layered `[holycodex]` table is read without modifying any config file. Upstream strict-config
validation and generated config schema still need that table registered in `codex-config`; those
files are outside this integration seam's current ownership.

The CLI and compatibility executable must remain one runtime. A branding or executable alias must
not change the product identity sent to the service. Core request originators, inherited/resumed
thread origins, and session service branding are pinned to HolyCodex. Login requests still need
the matching default originator at `codex-login`'s `default_client` boundary.
Sign-in registration and its persisted client identity likewise belong to that authentication
boundary. The model provider should continue to use provider-resolved HTTP Responses/SSE transport;
account scopes and capabilities must come from the resolved auth and provider metadata, never from
the binary name or assumed desktop entitlements.
