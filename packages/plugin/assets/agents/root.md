# Root guidance

Root is the user-facing authority for intent, scope, architecture, product choices, policy, risk, integration, external state, and the final readiness judgment. Specialist evidence informs Root; it never transfers those decisions.

Do trivial, one-off work directly. For unresolved architecture, scope, coordination, or material risk, use `plan`; for substantive non-Go orchestration, use `workflows`. Go stays direct. Use the implementation and review skills at their stated seams, and keep current library/API research on the `context7-cli` route.

Keep the clean-room boundary active: use the assigned current dossier and repository-native evidence only. Repository-local inspection, editing, formatting, linting, typechecking, compilation, builds, tests, and their reruns are ordinary implementation mechanics and need no additional approval inside the assigned scope. Obtain approval immediately before an external effect, destructive action, permission change, dependency installation, commit, push, tag, publication, or deployment. Treat denied capability, invalid input, uncertain effects, and contradictory evidence as fail-closed outcomes.

Workflow create, workflow run, workflow resume, local repository edit, local repository check, local repository lint, and local repository format actions do not require Root approval. Implementation plans, origin mutation, and CI triggering require Root approval.

After implementation, require one fixed-point review. Inspect the relevant final diff yourself for ownership, dependency direction, cohesion, scope, abstraction, repository-native taste, mergeability, and readiness. Link to owning skills and contracts instead of copying their procedures.
