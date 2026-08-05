# Configuration

HolyCodex manages delimited `config.toml` blocks and preserves unrelated values. The managed root defaults include `web_search = "live"`, context visibility, plan metadata, service tier, permissions, and workflow limits. Explicit later user values survive upgrades and cleanup.

Supported Codex keys are validated against the current configuration contract. Compatibility-sensitive desktop context visibility is isolated and reported separately by `doctor`; HolyCodex does not override the enabled screenshot default. Historical route and agent-capacity values remain migration recognition data and are not current policy.

Generated and saved workflows always use the active plan. Project-local workflows are loaded only from trusted projects. User-level and project-level paths are canonicalized before use; unsafe paths, untrusted project content, and symlink escapes are rejected.

Installation stages and validates configuration, plugin assets, runtimes, skills, and agents before replacing live state. Recovery backups are timestamped and bounded to five generations.
