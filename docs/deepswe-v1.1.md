# DeepSWE v1.1 cost-performance analysis

This document explains the benchmark evidence behind HolyCodex model routing. It uses the supplied DeepSWE v1.1 model, effort, pass@1, total cost per task, and average agent-step data. The costs already include the July 30, 2026 GPT-5.6 price changes. They are the live values for this analysis and must not be repriced again.

DeepSWE measures long-horizon software-engineering performance. It does not directly benchmark HolyCodex role boundaries, Librarian research, multi-agent coordination, Codex Fast latency, or subscription quota behavior. Routing therefore combines measured cost and success data with the different responsibilities of Root and delegated agents.

## Supplied benchmark data

Values are rounded only for presentation. Terra medium is the normalization baseline at exactly `1.00×`.

| model | effort | pass@1 | total cost/task | relative cost | average steps/task | relative cost/success | steps/success |
| ----- | ------ | -----: | --------------: | ------------: | -----------------: | --------------------: | ------------: |
| Luna  | low    |   1.5% |          $0.014 |         0.03× |               12.5 |                 0.70× |           805 |
| Luna  | medium |  11.3% |          $0.043 |         0.09× |               23.7 |                 0.29× |           210 |
| Luna  | high   |  44.2% |          $0.156 |         0.33× |               49.0 |                 0.26× |           111 |
| Luna  | xhigh  |  56.9% |          $0.307 |         0.66× |               71.1 |                 0.41× |           125 |
| Luna  | max    |  67.2% |          $0.606 |         1.30× |              101.7 |                 0.68× |           151 |
| Terra | low    |  24.1% |          $0.342 |         0.73× |               21.5 |                 1.07× |            89 |
| Terra | medium |  35.1% |          $0.467 |         1.00× |               25.1 |                 1.00× |            72 |
| Terra | high   |  53.8% |          $0.908 |         1.94× |               33.5 |                 1.27× |            62 |
| Terra | xhigh  |  60.2% |          $1.702 |         3.65× |               43.1 |                 2.13× |            72 |
| Terra | max    |  69.6% |          $3.957 |         8.48× |               75.9 |                 4.28× |           109 |
| Sol   | low    |  45.4% |          $1.074 |         2.30× |               23.4 |                 1.78× |            52 |
| Sol   | medium |  61.1% |          $1.862 |         3.99× |               30.9 |                 2.29× |            51 |
| Sol   | high   |  69.4% |          $3.470 |         7.44× |               36.9 |                 3.76× |            53 |
| Sol   | xhigh  |  70.7% |          $4.704 |        10.08× |               44.0 |                 5.00× |            62 |
| Sol   | max    |  72.7% |          $8.386 |        17.97× |               61.3 |                 8.68× |            84 |

## Calculations and normalization

The calculations use unrounded values internally:

```text
pass_fraction = pass_at_1_percent / 100

cost_per_success =
  total_cost_per_task / pass_fraction

steps_per_success =
  average_agent_steps / pass_fraction

relative_cost =
  total_cost_per_task / terra_medium_total_cost

relative_cost_per_success =
  cost_per_success / terra_medium_cost_per_success
```

Terra medium total cost is `$0.467`, so its relative cost is exactly `1.00×`. Its cost per success is also the normalization baseline at exactly `1.00×`.

Do not apply the July 30, 2026 repricing a second time. The supplied total cost per task values are already repriced. Do not multiply total cost by the agent-step count either. DeepSWE total cost already includes token usage across all steps, so that multiplication would double-count usage.

Step count is a separate signal. It helps characterize latency, orchestration burden, loops, retries, and reliability. It does not replace pass@1 or cost per success.

## Projected Luna Fast configurations

Codex Fast consumes exactly `2.5×` as much subscription usage as Standard. The following rows are projections from Standard Luna, not separately benchmarked runs. Fast leaves pass@1 and agent-step values unchanged. It changes latency and quota consumption only.

| projected configuration | pass@1 | projected cost/task | relative cost | steps/task | relative cost/success | steps/success |
| ----------------------- | -----: | ------------------: | ------------: | ---------: | --------------------: | ------------: |
| Luna Fast low           |   1.5% |              $0.036 |         0.08× |       12.5 |                 1.76× |           805 |
| Luna Fast medium        |  11.3% |              $0.108 |         0.23× |       23.7 |                 0.72× |           210 |
| Luna Fast high          |  44.2% |              $0.389 |         0.83× |       49.0 |                 0.66× |           111 |
| Luna Fast xhigh         |  56.9% |              $0.768 |         1.65× |       71.1 |                 1.02× |           125 |
| Luna Fast max           |  67.2% |              $1.514 |         3.24× |      101.7 |                 1.70× |           151 |

The projections use:

```text
fast_cost = standard_cost × 2.5
fast_cost_per_success = standard_cost_per_success × 2.5
```

Fast does not improve model quality, benchmark success, or agent-step efficiency. It is a latency option, not the usage-efficiency default.

## Measured domination comparisons

- Luna high is cheaper and substantially more capable than Terra low.
- Luna high reaches 44.2% instead of Terra medium's 35.1% while costing about 67% less.
- Luna xhigh reaches 56.9% instead of Terra high's 53.8% while costing about 66% less.
- Luna max reaches 67.2% instead of Terra xhigh's 60.2% while costing about 64% less.
- Sol high and Terra max are nearly tied in score, but Sol high is cheaper and uses far fewer steps.
- Luna xhigh costs about 82% less than Terra xhigh for only 3.3 percentage points less score.

## Cost-performance frontier

Luna high has the best measured cost-per-success ratio among reasoning efforts allowed in active HolyCodex routing. Luna xhigh is the stronger delegated-work option while remaining very inexpensive. Together, those results place Terra mostly outside the current measured cost-performance frontier. In particular, Terra xhigh is not justified for the `pro-20x` Worker when Luna xhigh gives nearly the same score at a fraction of the cost.

Raw run cost alone does not determine routing. Luna high and xhigh require roughly 111 to 125 expected steps per success, while Sol low through high requires roughly 51 to 53. Fewer expected loops matter most where failures or repeated coordination are expensive.

## Role-aware routing rationale

Root owns ambiguity resolution, architecture, integration, coordination, user interaction, and final verification. Sol's roughly 51 to 53 expected steps per success can justify its premium in that high-leverage role. Sol is not assigned to active subagents.

Relative cost per successful task is the primary usage-efficiency metric. Absolute capability is secondary because failed delegated work creates Root rework. Steps, orchestration reliability, latency, and output speed are tertiary. Sol remains preferred for paid-plan Root routes because orchestration failures affect the entire workflow. Explorer, Librarian, and Worker receive bounded tasks and use Luna only. `plus-low` uses Luna high specialists, `plus` keeps its Luna xhigh Worker, `plus-high` raises Worker to Luna max, `pro-5x` uses Luna xhigh research specialists and a Luna max Worker, and `pro-20x` uses Luna max specialists. `go` uses Luna xhigh for Root and Worker with Luna high research specialists.

All plans preserve subagent depth `1`. No active route uses Terra.

## Final HolyCodex routing

| plan        | Root       | Explorer   | Librarian  | Worker     | max direct subagents |
| ----------- | ---------- | ---------- | ---------- | ---------- | -------------------: |
| `go`        | Luna xhigh | Luna high  | Luna high  | Luna xhigh |                    0 |
| `plus-low`  | Sol low    | Luna high  | Luna high  | Luna high  |                    1 |
| `plus`      | Sol medium | Luna high  | Luna high  | Luna xhigh |                    2 |
| `plus-high` | Sol medium | Luna xhigh | Luna xhigh | Luna max   |                    2 |
| `pro-5x`    | Sol high   | Luna xhigh | Luna xhigh | Luna max   |                    2 |
| `pro-20x`   | Sol high   | Luna max   | Luna max   | Luna max   |                    2 |

`plus` is the default plan. Parent and specialist configuration is deterministic for the selected plan. Historical managed routes remain recognized only where needed for migration and cleanup.

## Fast-mode implications

HolyCodex writes `service_tier` directly into Root and every generated agent-role TOML configuration.

| CLI mode     | Root     | Explorer | Librarian | Worker   |
| ------------ | -------- | -------- | --------- | -------- |
| no Fast flag | Standard | Standard | Standard  | Standard |
| `--no-fast`  | Standard | Standard | Standard  | Standard |
| `--fast`     | Standard | Fast     | Fast      | Fast     |
| `--fast-all` | Fast     | Fast     | Fast      | Fast     |

The three flags are mutually exclusive. Upgrades remove stale HolyCodex-managed global Fast state before writing the selected Root and per-agent tiers. Unrelated user-owned configuration remains outside HolyCodex ownership, and cleanup removes or restores HolyCodex-managed tier settings.

Fast has a fixed `2.5×` usage multiplier and about `1.5×` output-token speed. It has no quality or step-count gain, so Standard remains the quota-efficient default.

## Limitations

DeepSWE pass@1 summarizes its benchmark task distribution and cannot predict every repository or task. The benchmark does not measure HolyCodex's exact orchestration policy, research quality, wall-clock latency, user-perceived quality, or subscription quota accounting. Expected cost and steps per success are derived averages, not guarantees for an individual task.

The Luna Fast rows are arithmetic projections using the supplied fixed usage multiplier. They are not independent benchmark observations and make no claim that Fast changes quality or agent-step efficiency.
