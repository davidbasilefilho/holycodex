# Durable implementation notes

## Codex plugin catalog compatibility

- Source revisions inspected: authenticated `codex-cli 0.145.0` and `@openai/codex@latest` on 2026-08-02; official OpenAI plugins marketplace and Codex plugin schema at their then-current `main` revisions.
- The observed `codex plugin list --available --json` envelope used top-level `installed` and `available` arrays. Entries exposed `pluginId`, `name`, `marketplaceName`, `version`, installation/enabled state, source, and policy fields. The sanitized deterministic fixtures omit paths, account data, credentials, versions unrelated to parsing, and unrelated catalog entries.
- Official marketplace data identifies the target as plugin `codex-security` in marketplace `openai-curated`; the canonical CLI identifier remains `codex-security@openai-curated`.
- The installer normalizes the observed flat envelope and marketplace-oriented envelopes with nested `plugins`. Unknown fields are ignored, malformed required containers or identifiers are rejected, and an exact idempotent add is followed by a fresh structured verification.
- Catalog absence and plugin-not-found are launcher-local. Deterministic PATH, Bun, npm, and pnpm candidates continue until verified success or exhaustion. Authentication and account/workspace policy rejection remain global stop conditions; the main HolyCodex install remains nonfatal.
- Process execution stays shell-free with fixed argument arrays, bounded output, and operation/package-bootstrap timeouts. Results expose only stable status/reason and launcher source identifiers, never raw diagnostics or executable paths.
