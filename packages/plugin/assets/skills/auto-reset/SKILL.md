---
name: auto-reset
description: Use when auto-reset is enabled; evaluate quota thresholds and safely use a currently supported banked reset.
---

# Auto reset

When the `auto-reset` capability is enabled, Root uses `holycodex-agent auto-reset read` to read fresh usage through the supported local `account/rateLimits/read` RPC and evaluate the returned Codex snapshot. The adapter detects a five-hour limit only from an observed 300-minute window; a weekly-only snapshot identifies a plan without a five-hour window. If quota evidence is missing, do not reset and report what is missing. Specialists never consume a reset credit; only Root owns this consequential action.

Continue only when a fresh `holycodex-agent auto-reset consume --idempotency-key <key>` returns a non-`notConsumed` outcome. That adapter rereads quota before acting, checks `availableCount > 0` and a credit row with `resetType: "codexRateLimits"` and `status: "available"`, and calls the typed local `account/rateLimitResetCredit/consume` RPC with that credit id. At an ask-permission threshold, Root first asks the user; only after explicit authorization pass `--authorization granted`. A refusal does not carry into the lower no-permission threshold; if Root tracks the refusal, pass `--authorization refused` on later attempts. Provide a unique idempotency key for each logical attempt and reuse it for retries. Never substitute an unbanked reset. Treat `nothingToReset`, `noCredit`, and `alreadyRedeemed` as exact RPC outcomes and report them.

For a plan with a 5-hour limit, Root asks the user before resetting if weekly remaining is below 15% or 5-hour remaining is below 20%. No permission is required if weekly remaining is below 7% or 5-hour remaining is below 15%. For a plan without a 5-hour limit, Root asks before resetting if weekly remaining is below 10%; no permission is required below 5% weekly remaining. Equality does not cross a threshold. Specialists return a required permission decision to Root and never ask the user.

A refusal at an ask-permission threshold does not carry forward once the lower no-permission threshold is reached. At that point follow the no-permission threshold, subject to the current supported banked reset mechanism and available quota evidence. Outside the thresholds, do not reset. Report the detected plan limit, measured remaining percentages, threshold applied, permission state, reset outcome, and evidence source without exposing unrelated account data.
