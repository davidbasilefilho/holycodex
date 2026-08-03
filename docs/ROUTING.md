# Model routing policy

HolyCodex selects routes after applying practical capability floors, then compares eligible configurations with this weighted criterion:

```text
weighted routing score =
  80% relative cost per success +
  20% relative cost per task
```

Relative cost per success is the primary weight. Relative cost per task is the secondary weight. A low weighted score cannot overcome inadequate capability. This excludes configurations such as Luna low and Luna medium even though they are cheap.

## Routing table

| plan        | Root       | Explorer  | Librarian | Worker     | max direct subagents |
| ----------- | ---------- | --------- | --------- | ---------- | -------------------: |
| `go`        | Luna high  | Luna high | Luna high | Luna high  |                    0 |
| `plus-low`  | Sol low    | Luna high | Luna high | Luna high  |                    2 |
| `plus`      | Sol medium | Luna high | Luna high | Luna high  |                    2 |
| `plus-high` | Sol medium | Luna high | Luna high | Luna xhigh |                    2 |
| `pro-5x`    | Sol high   | Luna high | Luna high | Luna xhigh |                    2 |
| `pro-20x`   | Sol high   | Luna high | Luna high | Luna max   |                    2 |

Every plan uses `maxDepth: 1`. `plus` is the default plan. `plus-low` defaults to two direct subagents, so generated configuration contains `max_threads = 3`; `max_threads` includes Root. Capacity does not require Root to delegate twice. Delegation still requires separable work, non-overlapping writes, and at most two lanes per wave. An explicit `--max-subagents` value overrides the plan default.

## Capability floors and role rationale

Explorer and Librarian use Luna high because their work is narrow, bounded, and reviewed by Root. Worker uses Luna high by default. `plus-high` and `pro-5x` use Luna xhigh Worker for greater implementation reliability; `pro-20x` uses Luna max Worker.

Paid-plan Root uses Sol because orchestration, architecture, integration, and final judgment affect the entire workflow. Sol high is the maximum built-in Root effort because Sol xhigh and max have poor marginal usage-to-performance.

## Standard benchmark data

DeepSWE is evidence used by this policy. It does not define the policy's purpose or directly measure HolyCodex role boundaries. Terra medium Standard is the `1.00×` baseline. Ratios are calculated directly from the displayed one-decimal score and three-decimal cost/task values:

```text
relative task cost =
  cost/task ÷ Terra medium cost/task

cost per success =
  cost/task ÷ pass@1

relative cost per success =
  cost per success ÷ Terra medium cost per success
```

| model | effort | score | cost/task | relative task cost | relative cost/success |
| ----- | ------ | ----: | --------: | -----------------: | --------------------: |
| Luna  | low    |  1.5% |    $0.014 |              0.03× |                 0.70× |
| Luna  | medium | 11.3% |    $0.043 |              0.09× |                 0.29× |
| Luna  | high   | 44.2% |    $0.156 |              0.33× |                 0.27× |
| Luna  | xhigh  | 56.9% |    $0.307 |              0.66× |                 0.41× |
| Luna  | max    | 67.2% |    $0.606 |              1.30× |                 0.68× |
| Terra | low    | 24.1% |    $0.342 |              0.73× |                 1.07× |
| Terra | medium | 35.1% |    $0.467 |              1.00× |                 1.00× |
| Terra | high   | 53.8% |    $0.908 |              1.94× |                 1.27× |
| Terra | xhigh  | 60.2% |    $1.702 |              3.64× |                 2.12× |
| Terra | max    | 69.6% |    $3.957 |              8.47× |                 4.27× |
| Sol   | low    | 45.4% |    $1.074 |              2.30× |                 1.78× |
| Sol   | medium | 61.1% |    $1.862 |              3.99× |                 2.29× |
| Sol   | high   | 69.4% |    $3.470 |              7.43× |                 3.76× |
| Sol   | xhigh  | 70.7% |    $4.704 |             10.07× |                 5.00× |
| Sol   | max    | 72.7% |    $8.386 |             17.96× |                 8.67× |

## Projected Fast data

Fast is a serving-tier latency option independent of model routing. It changes only `service_tier`, never the selected model or reasoning effort. The Fast cost/usage multiplier is `2×` Standard. Fast is assumed to preserve model quality and pass@1 because it is a serving-tier change. These rows are projections, not separate benchmark runs.

| model | effort | Fast cost/task | relative task cost | relative cost/success |
| ----- | ------ | -------------: | -----------------: | --------------------: |
| Luna  | low    |         $0.028 |              0.06× |                 1.40× |
| Luna  | medium |         $0.086 |              0.18× |                 0.57× |
| Luna  | high   |         $0.312 |              0.67× |                 0.53× |
| Luna  | xhigh  |         $0.614 |              1.31× |                 0.81× |
| Luna  | max    |         $1.212 |              2.60× |                 1.36× |
| Terra | low    |         $0.684 |              1.46× |                 2.13× |
| Terra | medium |         $0.934 |              2.00× |                 2.00× |
| Terra | high   |         $1.816 |              3.89× |                 2.54× |
| Terra | xhigh  |         $3.404 |              7.29× |                 4.25× |
| Terra | max    |         $7.914 |             16.95× |                 8.55× |
| Sol   | low    |         $2.148 |              4.60× |                 3.56× |
| Sol   | medium |         $3.724 |              7.97× |                 4.58× |
| Sol   | high   |         $6.940 |             14.86× |                 7.52× |
| Sol   | xhigh  |         $9.408 |             20.15× |                10.00× |
| Sol   | max    |        $16.772 |             35.91× |                17.34× |

Published Fast throughput information:

| model |                 Fast throughput |
| ----- | ------------------------------: |
| Luna  |   more than 100 output tokens/s |
| Terra |    more than 70 output tokens/s |
| Sol   |    more than 80 output tokens/s |
| Sol   | up to 2.5× faster than Standard |

At Sol's maximum advertised acceleration:

```text
2× usage ÷ 2.5× throughput = 0.80×
```

This does not make a task cheaper. The same task still consumes `2×` the API-equivalent usage, while generated output may arrive up to `2.5×` faster. End-to-end acceleration may be lower because tools, builds, tests, network waits, browser work, and other non-generation work are not accelerated.

## Fast modes

| CLI mode                    | Root     | subagents |
| --------------------------- | -------- | --------- |
| no Fast flag or `--no-fast` | Standard | Standard  |
| `--fast`                    | Standard | Fast      |
| `--fast-all`                | Fast     | Fast      |

The Fast flags affect only service tiers. Model routing and reasoning effort remain fixed by the selected plan.
