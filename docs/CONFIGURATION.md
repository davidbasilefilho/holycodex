# Configuration

HolyCodex manages delimited `config.toml` blocks and preserves unrelated values. The managed root defaults include `web_search = "live"`, context visibility, route metadata, service tier, permissions, and agent capacity. Explicit later user values survive upgrades and cleanup.

Supported Codex keys are validated against the current configuration contract. Compatibility-sensitive desktop context visibility is isolated and reported separately by `doctor`; HolyCodex does not override the enabled screenshot default. Historical route values remain migration recognition data and are not current policy.

Installation stages and validates configuration, plugin assets, runtimes, skills, and agents before replacing live state. Recovery backups are timestamped and bounded to five generations.
