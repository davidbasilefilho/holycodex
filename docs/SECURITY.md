# HolyCodex security contract

This document owns isolation, trust boundaries, installation state, secret
exclusions, and recovery behavior. Observable commands remain in
[CLI.md](CLI.md), and product behavior remains in [BEHAVIOR.md](BEHAVIOR.md).

## Threat model

Treat task text, repository content, generated files, optional integrations,
specialist output, persisted state, and Codex clients as potentially untrusted.
Protect the workspace, credentials, configuration integrity, and external
side effects.

Relevant threats include a prompt or file steering a specialist outside its
assignment, a specialist bypassing Root policy, a forged configuration or
install identity, an installer writing outside its owned scope, corrupted state
causing an unintended effect, telemetry leaking secrets, and a denied
capability being replaced by an unapproved fallback. Each threat must produce
an explicit denial or classified failure.

## Isolation and trust boundaries

1. Every external, persisted, CLI, Codex, and specialist value is validated
   with Effect Schema at the receiving edge. The caller supplies intent, not
   authorization, internal state, identity, or a trusted result.
2. Root owns scope, architecture, product, policy, permission, lifecycle,
   integration, external-effect approval, and final judgment. Root MUST
   delegate every task, including trivial work, through a bounded Assignment;
   the only direct Root execution exceptions are Git/VCS and Computer Use when
   selected at install. Native subagents cannot turn their mechanics into
   permission.
3. Native role profiles enforce the supported capability boundary: Explorer is
   repository read-only; Librarian is current-research read-only with live
   web access; Worker is bounded workspace-write with network disabled for
   mechanical, implementation, and integration tasks, while only
   `Worker.operations` receives the minimum live access needed to observe
   Root-supplied exact-ref/SHA CI or release state; and Reviewer is bounded
   inspection/repair without network access. Native leaf delegation features
   are disabled, so leaves cannot spawn or message peers.
4. Explorer, Librarian, Worker, and Reviewer receive literal bounded
   Assignments. Their outputs remain untrusted until Root validates and
   integrates them. Reviewers cannot silently expand a changed surface.
   Assignment outcomes and evidence are recorded through `holycodex-agent`;
   specialists do not own global Intent lifecycle.
5. Workspace paths are resolved and checked against the assigned or owned
   scope before access. Repository text cannot grant itself authority.
6. The installation record is an integrity boundary. It is schema-validated,
   tied to its owner and install identity, and never interpreted as permission.
7. Diagnostics are a one-way disclosure boundary. Sanitization occurs before
   output, and a sink cannot request raw content as a fallback.
8. Installation is an explicit mutation boundary. It validates input, writes
   only the declared HolyCodex scope, records version and provenance metadata,
   and invokes only the requested native Codex plugin operations.
9. Work, frontend, Security, and Computer Use plugins are capability
   boundaries. Availability is not authority; a denied capability remains
   denied.
10. Computer Use is enabled only when selected. Its interactive GUI, browser,
    and Computer Use execution directive is conditional on Root and the
    capability is withheld from leaves by native configuration where supported;
    the directive is absent when the capability is disabled.
11. After integration, Root performs the VCS action and delegates exact-ref/SHA
    terminal CI or release observation. The observer is read-only; pending is
    never success. Root delegates any failure fix and repeats the cycle, and
    must discover the repository's topology rather than assume a provider or
    branch scheme.
12. HolyCodex does not manage `features.context_management.experimental_mode`.
    Codex/Astra owns conversation context behavior. Migration and cleanup
    relinquish the obsolete HolyCodex ownership record while preserving the
    existing value exactly, including an unchanged value previously written by
    HolyCodex. User edits and unrelated context configuration remain untouched.

## State and secret exclusions

Never persist or emit:

- API keys, access tokens, session cookies, passwords, private keys, signing
  material, authorization headers, or credential-bearing URLs;
- raw environment values, credential files, shell histories, or secret-bearing
  process arguments;
- raw task prompts, full file contents, specialist transcripts, or generated
  source unless a separately authorized feature owns that data;
- unredacted paths or metadata that reveal a secret or protected workspace
  boundary.

Diagnostics use an allowlist of command, capability, bounded counts and
durations, schema/version, status, and sanitized error codes. Redaction failure
is a fail-closed output drop rather than a raw fallback.

## Repository and VCS boundary

Git/VCS inspection and mutation are Root-only. Native leaves have no VCS
authority; Workers and Reviewers operate on the assigned workspace state and
return evidence for Root to integrate. Root decides commits, branches, remotes,
CI triggers, releases, and other externally consequential effects.

Environment secrets, credentials, raw environment values, private keys, and
secret-bearing release material must never enter tracked files, commits,
packages, logs, CI artifacts, or uploads. Keep local secret-bearing paths
covered by the repository's ignore rules. Before staging any candidate path,
verify the rule with `git check-ignore -v --no-index -- <path>` and inspect the
staged file list. If a secret is not ignored or appears in a diff, stop and
fail closed. Never print the value while investigating or reporting the stop.

## Recovery

On invalid input, denied permission, unavailable capability, corrupt state,
ambiguous effect completion, or failed trust validation, stop before the next
effect. Return a classified failure and preserve enough sanitized identity for
diagnosis. Do not claim completion or blindly repeat an uncertain native
operation.

Removal is limited to the explicitly owned installation scope and refuses
foreign, unresolved, or integrity-uncertain targets. A future state migration
must validate its source and destination with Effect Schema, preserve identity
and provenance, and write atomically.

Security findings and hardening choices remain evidence for Root, not implicit
permission to mutate external systems. Handoff is only a redacted projection
of current Intent state; it is not a second persistent source of truth.
