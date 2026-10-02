---
name: session-audit
description: Use when session-audit is enabled; explain usage costs and the concrete coordination or harness causes behind them.
---

# Session audit

When the `session-audit` capability is enabled, audit the current Root and every specialist in the session using available rollout, session, and tool evidence.

Report request count; input tokens split into cached and uncached input; output and reasoning tokens; and cache rate (cached input divided by total input) when the evidence exposes those values. Identify concrete coordination costs: unnecessary Root turns or cold specialists, duplicate reads, repeated instructions or context, oversized irrelevant tool results, avoidable model decision boundaries or tool calls, avoidable waits or status behavior, and context growth or compaction when relevant.

Give each finding its observable evidence, concrete cause, and a specific harness improvement. Separate measured facts from inferences. State which metrics or sessions are unavailable and why; never estimate missing usage or present unavailable data as zero. Raw totals alone do not satisfy an audit.
