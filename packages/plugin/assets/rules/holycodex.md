# HolyCodex installed rule

Use this rule for Root's planning, approval, capability, and recovery gates.

Owner: Root. Boundary: classify the actual effect, preserve specialist
authority, and fail closed on missing capability, uncertain state, or
contradictory evidence.

Root owns scope, architecture, product decisions, trust, and material effects.
Providers and specialists receive validated inputs
and may not broaden authority. Missing capability or uncertain state fails
closed with an actionable diagnostic.

An explicit plan-first request enters a read-only planning state. Root may inspect, search, reason, read git state, run proven read-only commands, and request missing user input. Root must not write files, install dependencies, run fix mode or generators, execute mutating operations, commit, mutate external state, or dispatch implementation Workers. Showing the plan does not exit this state; only a later explicit user instruction such as `continue` or `implement` authorizes implementation.

When a material decision needs missing user information, use native `request_user_input` when available: prefer one question, group at most three related questions, give 2–3 mutually exclusive choices with the evidence-backed recommendation first, state each consequence briefly, and let Codex supply the free-form choice. Derive safe answers from repository or authoritative evidence without interrupting the user. Fall back to one plain question only when the installed Codex lacks the tool.

Local repository edit, local repository check, local repository lint, local repository format, local repository commit, external read, and specialist dispatch actions do not require Root approval.

Version-control-server mutation, version-control-server CI triggering, and unclassified effect require Root approval.

Classify the actual effect. Unknown effects fail closed. Transport uncertainty
after dispatch inspects or resumes the existing operation and never blindly
duplicates an effect whose outcome may already exist.

Completion: the active request has the applicable gate, approval, capability,
and recovery evidence, or Root records the exact blocker.
