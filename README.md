# HolyCodex

HolyCodex 0.17.0 is a Rust-native patch layer over the pinned OpenAI Codex
0.160.0 release. It installs one native runtime as `holycodex` and `codex`;
the compatibility name does not make HolyCodex identify as the official Codex
application. No JavaScript, Node.js, or Bun runtime is needed after installation.

> **Development status:** 0.17.0 is under active implementation. This source
> checkout is not a release-readiness claim. In particular, authentication
> identity, runtime integration, host capability preservation, supported
> platform builds, and complete third-party notices must pass their release
> checks before distribution.

The npm distribution is `holycodex`. It selects a matching optional native
package during installation and exposes the installed executables as npm bins.
Current packaging targets are Linux x64 (glibc), macOS Apple silicon, and
Windows x64. npm/Node is needed to install the package; the installed commands
are native programs.

See [development](docs/DEVELOPMENT.md) for building and testing, and
[release procedure](docs/RELEASING.md) for source and artifact identity gates.
See [LICENSE](LICENSE), [NOTICE](NOTICE), and
[third-party notices](THIRD-PARTY-NOTICES.md) for licensing information.
