# Native dependency/license evidence

This maintenance-only Python 3.11+ tool inventories the **materialized** pinned
Codex workspace, including HolyCodex additions. It does not inspect the small
HolyCodex development-tool workspace in place of the native CLI.

Upstream already checks license policy with `cargo-deny` and
`codex-rs/deny.toml` (see its `.github/workflows/cargo-deny.yml`). Keep using that
policy check. This script adds the missing package/source/text evidence; it
neither replaces cargo-deny nor interprets or approves SPDX expressions.

## Run

First use the normal `holycodex-dev` materialization procedure. Use that
workspace's pinned Rust/Cargo toolchain, and the same feature/build environment
as the native build. This tool currently supports the release's default
features only. Cargo may download the locked sources, but no build script or
runtime executable is run. Add `--offline` after the cache is populated.

From the HolyCodex source checkout, once for each advertised target:

```sh
python3 tools/license-inventory/inventory.py \
  --source-root /path/to/materialized-upstream \
  --manifest-path /path/to/materialized-upstream/codex-rs/cli/Cargo.toml \
  --target x86_64-unknown-linux-gnu \
  --output /path/to/evidence/linux
```

Repeat with `aarch64-apple-darwin` and `x86_64-pc-windows-msvc`, choosing separate
output directories. On Windows, use the available Python 3.11+ launcher in
place of `python3`. `--cargo` accepts an explicit Cargo executable if needed.
An inherited `RUSTUP_TOOLCHAIN` overrides `rust-toolchain.toml`; unset it or
select the same pinned version intentionally. Run on each native build host
for final evidence because build dependencies and proc macros use the host.
Cross-target collection is useful for review, not evidence of a native build.

The output must be new and outside the source root. Existing evidence is never
overwritten. The command returns nonzero on absent/ambiguous identities,
missing license metadata/text, conflicting checksums/licenses, changed source,
escaping paths, or command failures. A collection with package-level errors
still writes an explicitly `incomplete` report, including unresolved package
metadata and errors. A command failure before collection produces no report.

## Evidence and limits

- Cargo's locked `tree --target TARGET --edges normal,build` selects the union
  of production closures rooted at `codex-cli`, `codex-code-mode-host`, and
  the target helper (`codex-bwrap` on Linux; `codex-windows-sandbox` on Windows).
  macOS has no additional Cargo sandbox helper. Repeated `--package` flags can
  explicitly inspect a narrower set, recorded as `distribution_scope: false`;
  that output cannot represent the complete distribution. The default selects the production source closure, including build dependencies and
  procedural macros. Dev-only edges and disabled optional dependencies are
  excluded. Cargo handles cfg expressions and feature unification; the script
  does not attempt its own resolver or call every Cargo.lock entry a runtime
  dependency. The retained tree records selected feature sets.
- `cargo metadata --locked --format-version 1` provides package identities,
  versions, source revisions and declared licensing. It is intentionally not
  filtered to the target, because conditional build-host dependencies can be
  absent from target-only metadata during cross-target collection. Only the
  target-specific production tree selects packages for the inventory; collecting
  all metadata does not make unrelated, dev-only or disabled packages runtime
  dependencies. Metadata may need additional locked source downloads.
  Each selected identity must have exactly one matching Cargo.lock entry.
  Same-name/same-version packages from multiple sources fail as ambiguous rather
  than being guessed.
- Registry checksums are the expected **Cargo.lock** checksums; a present Cargo
  source checksum file must agree. They are not a claim that every extracted
  registry file was independently rehashed. Git dependency checkouts must match
  their locked revision. Local source identity includes the repository revision
  and a content fingerprint of tracked and non-ignored files, including changes
  and deletions; Git-ignored build inputs require separate review.
- Conventional LICENSE, LICENCE, COPYING, NOTICE, COPYRIGHT and AUTHORS files,
  nested license directories, and declared `license-file` paths are copied
  byte-for-byte to content-addressed `texts/` files. Workspace/Git ancestors'
  top-level license/notice files are included as candidates. Internal file
  symlinks are allowed only within the source root and their targets recorded;
  directory symlinks are not traversed. These are candidates for review, not a
  determination that every detected license applies.
- `inventory.json`, original Cargo metadata/tree, and Cargo.lock are preserved.
  Package IDs/source paths in raw evidence may contain absolute local paths;
  review these before sharing publicly. Given the same source/cache/toolchain
  paths and inputs, the report is deterministic; it has no wall-clock timestamp.

Even an exit status of zero means only `source_inventory_collected`.
`legal_completeness` **always remains `unverified`**. Cargo itself documents that
[cargo tree](https://doc.rust-lang.org/cargo/commands/cargo-tree.html) does not
guarantee exact equivalence to compiled contents. This tool is not a linked
binary scanner or legal approval. Run upstream's cargo-deny check, reconcile
all missing/conflicting source evidence, review bundled ripgrep and codex-zsh,
vendored bubblewrap/libcap and V8/native components and embedded assets, and incorporate approved texts/attributions
into the source and every native package before the existing release gate can
be accepted. Never fill gaps by inventing text from a license expression.

## Tests

```sh
python3 -m unittest discover -s tools/license-inventory -v
```

Cargo and Git are needed for the real offline fixture. Those tests are skipped
if either executable is absent; a skipped fixture is not a successful resolver
validation. The fixture covers Linux/Windows target selection, build edges,
optional features, exclusion of dev-only features on shared dependencies,
byte-identical repeat output, and incomplete-report failure behavior. Unit
checks cover identity ambiguity, checksum and licensing conflicts, missing
texts, nested notices, and bounded symlink/path handling.
