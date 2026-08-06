# Dynamic workflow policy

HolyCodex uses model-authored dynamic workflows instead of strict role routing, mandatory delegation thresholds, fixed lanes, or fixed waves as its primary orchestrator on paid plans. Root authors plain JavaScript for the current task and the script decides which agents run next from intermediate results. Concise updates name each specialist type and what it will do without explaining delegation rationale unless the user asks. On paid plans, specialist agents run through workflows unless the workflow runtime is unavailable or cannot perform the operation. Go disables workflows, so Root works directly without specialist agents.

Workflows can use sequential phases, parallel fan-out, dynamic discovery, conditions, bounded loops, retries, iterative fix-and-check cycles, independent attempts, adversarial verification, deduplication, ranking, and synthesis. Several workflows may run in sequence for one request. Important findings require independent verification before they are presented as confirmed, and implementation workflows must verify their work before completion.

Explorer, Librarian, and Worker remain available capability profiles. They are selected dynamically and do not imply a fixed Explorer to Librarian to Worker sequence. Root remains responsible for material decisions, integration, final judgment, and final verification.

## Script contract

Saved and generated workflows use JavaScript with top-level `await`:

```js
export const meta = {
  name: "review-changes",
  description: "Review changed files and verify the findings",
};

const files = await agent("List every changed source file.", {
  agent: "explorer",
  schema: {
    type: "object",
    required: ["files"],
    properties: {
      files: { type: "array", items: { type: "string" } },
    },
  },
});

const findings = await pipeline(files.files, (file) =>
  agent(`Review ${file} for correctness issues.`, {
    agent: "worker",
    stage: "analysis",
    label: file,
    phase: "review",
  }),
);

return agent("Deduplicate, rank, and independently verify these findings.", {
  agent: "worker",
  context: findings.filter(Boolean),
  phase: "verification",
  stage: "verification",
});
```

Scripts may use normal variables, objects, arrays, functions, conditions, loops, and error handling. `agent()` returns structured output when a schema is supplied and `null` for an allowed partial failure. The `stage` option selects the stage baseline; `routeIndex` selects a stronger permitted route only when complexity, uncertainty, risk, failed checks, or an earlier insufficient result justifies escalation. `pipeline()` preserves input order and partial failures while respecting active concurrency and fan-out limits. Structured invocation data is available through `args`.

The current CLI host dispatches `agent()` through Codex App Server, which creates independent threads that are not displayed as children of the active task. That UI limitation is not a reason to prefer native subagents. Paid plans use workflows for substantive specialist work; native subagents are fallback-only when the workflow runtime is unavailable or cannot perform the operation.

## Plans and quotas

Plans remain authoritative. Go does not support workflows, so Root works directly without specialist agents. Paid plans define permitted stage routes, low verbosity, concurrency, soft target calls, hard maximum calls, depth, retries, loop iterations, fan-out, projected usage, and soft size guidance. Target calls guide normal planning; the hard maximum is only a safety and quota ceiling. Root remains near the target, exceeds it only when intermediate evidence justifies more work, uses the smallest useful fan-out, stops discovery when evidence is sufficient, and avoids duplicate investigation. Larger plans do not automatically consume larger allowances.

| plan        | Root       | Explorer           | Librarian          | Worker analysis    | Worker implementation | Worker verification | target / max calls |
| ----------- | ---------- | ------------------ | ------------------ | ------------------ | --------------------- | ------------------- | -----------------: |
| `go`        | Luna high  | Luna high          | Luna high          | Luna high          | Luna high             | Luna high           |              2 / 4 |
| `plus-low`  | Sol low    | Luna high          | Luna high          | Luna high          | Luna high             | Luna high           |             4 / 12 |
| `plus`      | Sol medium | Luna high          | Luna high          | Luna high to xhigh | Luna high to xhigh    | Luna xhigh          |             6 / 16 |
| `plus-high` | Sol high   | Luna high to xhigh | Luna high to xhigh | Luna xhigh         | Luna xhigh to max     | Luna max            |             8 / 24 |
| `pro-5x`    | Sol high   | Luna xhigh         | Luna xhigh         | Luna xhigh to max  | Luna max              | Luna max            |            12 / 40 |
| `pro-20x`   | Sol high   | Luna xhigh to max  | Luna xhigh to max  | Luna max           | Luna max              | Luna max            |            20 / 80 |

`plus-low` is the default and relative `1.00×` usage baseline. Typical Standard usage targets are `go` 0.20–0.35×, `plus` 1.4–1.7×, `plus-high` 2.4–3.1×, `pro-5x` 4–5×, and `pro-20x` 8–12×, with the latter allowed to use its larger envelope only when justified. Higher plans buy stronger Root judgment, stronger Luna routes, independent attempts, repair and check cycles, breadth, adversarial review, and repeated verification.

## Routing metric

Routing prioritizes cost per successful task and uses GPT-5.6 Terra medium Standard as `1.00×`:

```text
relative task cost = model cost per task / Terra medium cost per task
cost per success = model cost per task / pass@1
relative cost per success = model cost per success / Terra medium cost per success
weighted relative cost = 0.80 × relative cost per success + 0.20 × relative task cost
```

Lower is better, but minimum stage capability remains mandatory. Luna high is the substantive specialist floor, Luna xhigh is the efficient upgrade, and Luna max provides near-frontier specialist capability. Default routes exclude Terra, Sol xhigh, and Sol max. Sol max remains available only through explicit user configuration.

Workflows have no wall-clock deadline. They end through successful completion, user or host cancellation, quota exhaustion, bounded-operation failure, or inactivity and hang protection. Individual command and tool timeouts remain valid; no arbitrary workflow-wide duration ceiling replaces the removed timeout.

Standard is the default service tier. Fast is only a latency-oriented opt-in: `--fast` applies Fast to workflow agents and `--fast-all` also applies it to Root. Neither flag changes model selection or reasoning effort. Fast projected usage is 2× Standard, while tools, tests, builds, sequential dependencies, and workflow coordination can limit end-to-end latency gains.

The runtime records call count, active and peak concurrency, retries, selected model, effort, service tier, token usage where Codex reports it, projected usage, duration, phase state, errors, and cancellation. It rejects uncontrolled fan-out, recursive spawning, unsafe nested execution, infinite execution, and quota exhaustion.

## Concealment and inspection

Normal conversation receives concise orchestration updates and the final coordinated result. It does not receive generated prompts, model selection, reasoning effort, quota calculations, workflow variables, system instructions, hidden reasoning, credentials, or raw child transcripts.

Explicit workflow inspection may show the script, public metadata, phases, operational status, aggregate usage, errors, and sanitized agent results. The same concealment rules still apply.
