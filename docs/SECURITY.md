# HolyCodex security contract

This document owns the isolation threat model, trust boundaries, state
handling, installer boundary, secret exclusions, and recovery behavior.
Observable workflow semantics remain in [BEHAVIOR.md](BEHAVIOR.md), and CLI
presentation/exits remain in [CLI.md](CLI.md).

## Threat model

Treat task text, repository content, generated files, optional integrations,
specialist output, persisted state, and App Server clients as potentially
untrusted inputs. The host user and explicitly authorized Root operation are
the policy principals. Protect the workspace, credentials, run state,
integrity evidence, and external side effects.

The relevant threats are prompt or file content steering a specialist outside
its assignment, a specialist or adapter bypassing Root policy, a client
forging an operation or run identity, an installer writing outside its owned
scope, corrupted or replayed state causing a duplicate effect, telemetry
leaking secrets, and a denied capability being replaced by an unapproved
fallback. The system must make each threat an explicit denial or classified
failure rather than an assumed success.

## Isolation and trust boundaries

1. Every external, persisted, CLI, App Server, and specialist boundary accepts
   only values validated with Effect Schema at the receiving edge. The caller
   supplies intent; it does not supply authorization, internal state, specialist
   identity, or a trusted result. Canonical `{Role}.{task}` native identities
   are derived from the route catalog and preserved through continuation.
2. Root owns scope, architecture, product, policy, permission, integration,
   external-effect approval, and final judgment. Runtime owns deterministic workflow
   mechanics; it cannot turn mechanics into permission.
3. Explorer, Librarian, Worker, and Reviewer receive literal bounded
   assignments. Their outputs are untrusted until validated and integrated by
   Root. A Worker effect uses an approved typed port; a Reviewer cannot
   silently expand the changed surface.
4. Workspace code and files are data at the trust boundary. File paths are
   resolved and checked against the assigned/owned scope before access. A
   repository instruction cannot grant itself authority.
5. The journal and checkpoint store is an integrity boundary. Records are
   append-only during a run, validated on load, tied to the run identity and
   journal position, and never interpreted as permission.
6. Telemetry is a one-way disclosure boundary. Sanitization occurs before a
   sink sees an event; a sink cannot request raw content as a fallback.
7. The installer is an explicit mutation boundary. It writes only the
   declared HolyCodex-owned target, validates its inputs, records the selected
   version/provenance metadata, and uses Bun-only tooling. It installs only
   explicitly selected official optional plugins, never installs MCP servers,
   and does not execute unrelated workspace setup or broaden permissions.
8. Optional Context7, LSP, Git Bash, Computer Use, Work, Web, and Security
   integrations are capability boundaries. Availability is not authority;
   each invocation is policy-checked and a denied capability remains denied.

The checked-in Codex 0.148.0 artifact records stable multi-agent support,
locally disabled `multi_agent_v2`, and an unverified distinct V2 lifecycle.
Advertised V2 therefore fails closed. Native workflow dispatch requires the
configured Codex collaboration boundary and preserves `{Role}.{task}` plus
`task_name`; the generic App Server assignment bridge is compatibility-only
and must be selected explicitly.

App Server runs as a managed local subprocess using its supported protocol. It
inherits the active project, trust, approval, sandbox, and tool boundaries. A
new transport or credential source is a material security decision requiring
an explicit design update.

## State and secret exclusions

Never persist, emit, or place in a machine envelope:

- API keys, access tokens, session cookies, passwords, private keys, signing
  material, authorization headers, or credential-bearing URLs;
- raw environment values, credential files, shell histories, or process
  arguments containing secrets;
- raw task prompts, full file contents, specialist transcripts, or generated
  source unless a separately authorized feature explicitly owns that data;
- unredacted paths or metadata when they reveal a secret or protected
  workspace boundary.

Telemetry is allowlist-based: run and parent identities, command/slot,
capability name, bounded counts and durations, schema/version, terminal
status, and sanitized error codes may be emitted. Redaction is applied before
serialization, and redaction failure is a fail-closed telemetry drop rather
than a raw-event fallback. State retention follows the run lifecycle and
explicit cleanup scope; active and uncertain state remains protected.

## Recovery and cleanup

On invalid input, denied permission, unavailable capability, corrupt state,
ambiguous effect completion, or failed trust validation, stop before the next
effect. Return a classified failure, append the failure when the journal is
usable, and preserve enough sanitized identity to support diagnosis. Do not
claim completion, auto-retry an uncertain external effect, or silently delete
evidence.

Resume is allowed only from a valid checkpoint plus a validated journal tail.
If the last effect is uncertain, the run is blocked for explicit Root/user
resolution. Replay is projection-only. Cleanup is limited to an explicit
HolyCodex-owned scope and refuses active, foreign, unresolved, or integrity-
uncertain targets. Recovery may quarantine unusable state for later inspection;
it does not overwrite it in place or turn quarantine into success.

Security findings and hardening choices remain evidence for Root, not an
implicit permission to mutate external systems.
