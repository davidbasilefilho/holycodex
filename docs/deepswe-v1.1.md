# DeepSWE v1.1 price-performance analysis

This analysis uses the [DeepSWE v1.1](https://deepswe.datacurve.ai/) snapshot and the [July 30, 2026 GPT-5.6 pricing announcement](https://openai.com/index/advancing-the-price-performance-frontier-with-gpt-5-6/) to recalculate HolyCodex routing. It separates measured benchmark evidence from routing inferences.

## Benchmark snapshot

DeepSWE v1.1 contains 113 original, long-horizon software-engineering tasks across 91 repositories and five languages. Runs use mini-swe-agent. The benchmark measures model configurations on the same task set, but it does not directly test HolyCodex role boundaries or Librarian web research.

Values below are rounded for presentation. Derived values were calculated from the underlying unrounded snapshot and therefore may not reproduce exactly from the displayed rounded numbers.

| model | effort | pass@1 | mean input/output | steps/run | repriced $/run | run cost | cost/success | steps/success |
| ----- | ------ | -----: | ----------------: | --------: | -------------: | -------: | -----------: | ------------: |
| Luna  | low    |   1.5% |      0.15M / 3.1K |      12.5 |         $0.014 |    0.03× |        0.70× |           805 |
| Luna  | medium |  11.3% |      0.62M / 8.2K |      23.7 |         $0.043 |    0.09× |        0.29× |           210 |
| Luna  | high   |  44.2% |     3.37M / 25.8K |      49.0 |         $0.156 |    0.33× |        0.26× |           111 |
| Luna  | xhigh  |  56.9% |     7.61M / 44.7K |      71.1 |         $0.307 |    0.66× |        0.41× |           125 |
| Luna  | max    |  67.2% |    15.44M / 73.4K |     101.7 |         $0.606 |    1.30× |        0.68× |           151 |
| Terra | low    |  24.1% |      0.48M / 8.6K |      21.5 |         $0.342 |    0.73× |        1.07× |            89 |
| Terra | medium |  35.1% |     0.73M / 11.7K |      25.1 |         $0.467 |    1.00× |        1.00× |            72 |
| Terra | high   |  53.8% |     1.56M / 21.5K |      33.5 |         $0.908 |    1.94× |        1.27× |            62 |
| Terra | xhigh  |  60.2% |     3.25M / 39.6K |      43.1 |         $1.702 |    3.65× |        2.13× |            72 |
| Terra | max    |  69.6% |     9.23M / 71.9K |      75.9 |         $3.957 |    8.48× |        4.28× |           109 |
| Sol   | low    |  45.4% |     0.69M / 10.6K |      23.4 |         $1.074 |    2.30× |        1.78× |            52 |
| Sol   | medium |  61.1% |     1.51M / 18.4K |      30.9 |         $1.862 |    3.99× |        2.29× |            51 |
| Sol   | high   |  69.4% |     2.71M / 28.5K |      36.9 |         $3.470 |    7.44× |        3.76× |            53 |
| Sol   | xhigh  |  70.7% |     4.26M / 40.7K |      44.0 |         $4.704 |   10.08× |        5.00× |            62 |
| Sol   | max    |  72.7% |     7.91M / 60.0K |      61.3 |         $8.386 |   17.97× |        8.68× |            84 |

## July 30, 2026 price change

Standard API prices per one million tokens changed as follows:

| model | old input/output | new input/output | cost multiplier |
| ----- | ---------------: | ---------------: | --------------: |
| Luna  |          $1 / $6 |    $0.20 / $1.20 |            0.20 |
| Terra |      $2.50 / $15 |         $2 / $12 |            0.80 |
| Sol   |         $5 / $30 |         $5 / $30 |            1.00 |

OpenAI kept ChatGPT and Codex subscription prices and quota budgets unchanged. Terra and Luna therefore consume fewer credits, while Sol Standard usage is unchanged.

## Recalculation method

The benchmark's measured original per-run cost is repriced by the model multiplier:

```text
repriced_cost = original_deepswe_cost × model_multiplier
```

This analysis does not calculate cost naively from the displayed aggregate input-token total. Repeated context can be cached, while the benchmark's measured cost already incorporates its actual token-accounting behavior.

Run cost is normalized to Terra medium:

```text
relative_run_cost = repriced_cost / repriced_terra_medium_cost
```

Terra medium is exactly `1.00×`. Expected cost per successful result is normalized the same way:

```text
relative_cost_per_success = (repriced_cost / pass_at_1) / (terra_medium_cost / terra_medium_pass_at_1)
```

Expected agent steps per successful result are:

```text
steps_per_expected_success = mean_agent_steps / pass_at_1
```

Pass rates are converted from percentages to fractions for both formulas.

## Measured comparisons

- Luna high beats Terra medium by 9.1 percentage points while costing about 67% less per run.
- Luna xhigh beats Terra high by 3.1 points while costing about 66% less per run, although it uses substantially more agent steps.
- Luna xhigh trails Sol medium by 4.2 points while costing about 84% less per run.
- Luna max trails Sol high by only 2.2 points while costing about 83% less, but HolyCodex intentionally excludes `max` routing.
- Sol high to Sol xhigh adds only about 1.3 points while increasing run cost substantially.

The snapshot supports four broader observations:

- Luna high and xhigh now dominate Terra medium and high on DeepSWE cost-to-performance.
- Luna low and medium have poor pass rates and high expected retry and turn burdens despite tiny raw prices.
- Sol uses fewer agent steps and remains valuable when ambiguity resolution and integration quality matter most.
- Terra xhigh is much more expensive than Luna xhigh, but it is somewhat more capable and uses fewer steps.

## Routing inference

The benchmark evidence does not assign models to HolyCodex roles by itself. HolyCodex applies it as follows:

- Root receives Sol on paid plans because Root handles the highest-leverage decisions, architecture, integration, and final verification.
- No active subagent receives Sol because its price is difficult to justify for bounded delegated work after Luna's 80% cut.
- Explorer starts at Luna high on paid plans. Luna low and medium are too unreliable on long-horizon work.
- Librarian uses Luna high on `plus-low` and Luna xhigh above it. This is a routing extrapolation for bounded, high-volume research, not a directly benchmarked Librarian result, because DeepSWE does not measure web research.
- Worker generally uses Luna xhigh because it delivers strong performance at extremely low relative cost.
- The `pro-20x` Worker uses Terra xhigh because implementation is the subagent role where fewer loops and somewhat greater reliability can plausibly justify Terra's premium on the highest-budget plan.
- `go` remains Terra-only because that subscription tier exposes Terra rather than Luna or Sol.
- Increasing plan level buys stronger Root reasoning, stronger subagent reasoning, or both. It does not buy unnecessary Sol subagents.

## Final HolyCodex routing

Parenthesized values are approximate DeepSWE relative run costs. Every plan retains subagent depth 1.

| plan        | Root                 | Explorer           | Librarian          | Worker               | direct subagents |
| ----------- | -------------------- | ------------------ | ------------------ | -------------------- | ---------------: |
| `go`        | Terra medium (1.00×) | Terra low (0.73×)  | Terra low (0.73×)  | Terra medium (1.00×) |                0 |
| `plus-low`  | Sol low (2.30×)      | Luna high (0.33×)  | Luna high (0.33×)  | Luna xhigh (0.66×)   |                1 |
| `plus`      | Sol medium (3.99×)   | Luna high (0.33×)  | Luna xhigh (0.66×) | Luna xhigh (0.66×)   |                2 |
| `plus-high` | Sol medium (3.99×)   | Luna xhigh (0.66×) | Luna xhigh (0.66×) | Luna xhigh (0.66×)   |                2 |
| `pro-5x`    | Sol high (7.44×)     | Luna xhigh (0.66×) | Luna xhigh (0.66×) | Luna xhigh (0.66×)   |                2 |
| `pro-20x`   | Sol high (7.44×)     | Luna xhigh (0.66×) | Luna xhigh (0.66×) | Terra xhigh (3.65×)  |                2 |

`plus` remains the default plan. Active Explorer, Librarian, and Worker routes never use Sol. Historical Sol specialist routes remain in managed migration history only so upgrades and cleanup can recognize configurations generated by older HolyCodex versions.

## Limitations

DeepSWE is a software-engineering benchmark under mini-swe-agent, not a direct measurement of HolyCodex orchestration, repository search, web research, subscription credit accounting, latency, or user-perceived quality. Pass@1 aggregates a fixed benchmark and cannot predict every repository or task distribution.

More agentic turns generally increase real task cost through additional context, outputs, tool calls, latency, and opportunities for failure. Weaker configurations can also require more retries. Raw steps per run alone can be misleading because weak agents may terminate early. Pass@1, cost per successful result, and steps per expected success should be considered together.
