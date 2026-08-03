---
name: context7-cli
description: Use first for current library, framework, SDK, or API documentation within assigned scope; use web search only for releases, dates, broader research, missing coverage, or corroboration. Runs Context7 through the bundled runner, never MCP or a global install.
---

# Context7 CLI

Run the direct `ctx7@latest` command selected by HolyCodex. Never install it globally, authenticate, configure MCP, or send sensitive or proprietary data.

Use the two-step documentation workflow in [references/docs.md](references/docs.md). Resolve a library ID first unless the user supplied `/org/project` or `/org/project/version`, then query that ID. Use at most three `library` calls and three `docs` calls per question.

Unauthenticated skill management may use `skills search`, `skills suggest`, `skills list`, `skills info`, project-local `skills install`, and project-local `skills remove`. Do not use global, login-dependent, setup, or generation workflows.
