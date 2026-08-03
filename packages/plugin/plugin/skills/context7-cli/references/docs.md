# Documentation workflow

## Resolve the library

Run `ctx7 library <name> "<specific single-topic question>"`. The query is required and affects ranking. Never include credentials, personal data, proprietary code, or other sensitive material.

Choose the closest name and intent match with strong coverage, source reputation, and benchmark score. If the request names a version, select the closest listed `/org/project/version`. Clarify genuinely ambiguous libraries. Stop after three attempts and use the best available result.

## Query documentation

Run `ctx7 docs /org/project[/version] "<specific single-topic question>"`. Skip resolution only when the user supplied a valid library ID. Prefer one topic per query and stop after three calls.

Use `--json` when structured output helps. If Context7 coverage is absent or insufficient, use live web search for the gap and corroboration.
