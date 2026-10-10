# Third-party notices

## OpenAI Codex

HolyCodex 0.17.0 is being developed as a patch layer over OpenAI Codex release
0.160.1, upstream commit
`d27764b82f7118f674371e6d6e76271d9d606edb`:
<https://github.com/openai/codex/tree/d27764b82f7118f674371e6d6e76271d9d606edb>

The upstream Codex source is licensed under Apache License 2.0; see
[LICENSE](LICENSE). The upstream `NOTICE` attribution for Codex and Ratatui is
retained in [NOTICE](NOTICE).

## toon-rs codec adaptation

`crates/holycodex-toon` adapts the safe Rust codec source from `toon-rs`
3.0.0's unpublished main revision
`e80011112a3d54abe3c38edc362ff95c52134243`, repository
<https://github.com/jimmystridh/toon-rs>. The upstream manifest declares the
MIT License. The adaptation is maintained against TOON 4.1; see the crate's
`NOTICE` and `LICENSE` for attribution and license text. This attribution does
not imply upstream endorsement or 4.1 conformance of the unmodified source.

## Inventory status

This file is not yet a complete binary redistribution notice. The release
maintainer must inventory the exact locked Rust dependency closure and all
licenses/notices shipped by each target build, retain applicable attributions,
and include the completed notices in every source and npm binary package
before publishing. The npm installer itself uses only Node.js built-in
modules.

After runtime dependencies stabilize and the final patched CLI compiles,
generate the source inventory from that workspace's locked Cargo metadata
for each supported Rust target. Traverse the resolved dependency closure
rooted at `codex-cli`; record each exact package name, version, source/revision
or registry checksum, license expression, license-file path, and applicable
license/notice text. Include HolyCodex's own runtime additions and review
target-specific and non-Cargo bundled components as well. Cargo.lock alone
does not contain complete license metadata. Reconcile that inventory into
this root notice before staging final source or binary packages.

The development packager uses `serde_json`, `sha2`, and `toml` (each MIT OR
Apache-2.0). Its dependencies must be included in the root Cargo.lock when
Root registers `npm/packager` as a workspace member. These are build
dependencies; the complete runtime and source dependency inventory remains
pending final dependency stabilization and compilation.
