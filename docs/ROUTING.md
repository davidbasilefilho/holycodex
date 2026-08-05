# Dynamic workflow policy

HolyCodex uses model-authored dynamic workflows instead of strict role routing, mandatory delegation thresholds, fixed lanes, or fixed waves as its primary orchestrator. Root authors plain JavaScript for the current task and the script decides which isolated agents run next from intermediate results.

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
    label: file,
    phase: "review",
  }),
);

return agent("Deduplicate, rank, and independently verify these findings.", {
  agent: "worker",
  context: findings.filter(Boolean),
  phase: "verification",
});
```

Scripts may use normal variables, objects, arrays, functions, conditions, loops, and error handling. `agent()` returns structured output when a schema is supplied and `null` for an allowed partial failure. `pipeline()` preserves input order and partial failures while respecting active concurrency and fan-out limits. Structured invocation data is available through `args`.

## Plans and quotas

Plans remain authoritative. Each plan defines permitted model routes by capability or stage, reasoning effort, low model verbosity, concurrent agents, total calls, nested stage depth, retries, loop iterations, fan-out, projected usage, and wall-clock runtime. Soft size guidance helps Root produce an appropriately sized workflow. Hard runtime limits cannot be changed or bypassed by workflow JavaScript.

Fast is only a service-tier choice. `--fast` applies Fast to workflow agents and `--fast-all` also applies it to Root. Neither flag changes model selection or reasoning effort.

The runtime records call count, active and peak concurrency, retries, selected model, effort, service tier, token usage where Codex reports it, projected usage, duration, phase state, errors, and cancellation. It rejects uncontrolled fan-out, recursive spawning, unsafe nested execution, infinite execution, and quota exhaustion.

## Concealment and inspection

Normal conversation receives concise progress and the final coordinated result. It does not receive generated prompts, model selection, reasoning effort, quota calculations, workflow variables, system instructions, hidden reasoning, credentials, or raw child transcripts.

Explicit workflow inspection may show the script, public metadata, phases, operational status, aggregate usage, errors, and sanitized agent results. The same concealment rules still apply.
