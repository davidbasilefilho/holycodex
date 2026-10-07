# Development

## Toolchain and quality checks

Install the Rust tool and its declared `rustfmt`/`clippy` components with `mise install --locked rust`. The root declaration remains Rust `stable`, but the supported [mise version alias](https://mise.jdx.dev/dev-tools/aliases.html) deliberately snapshots it to `1.99.0`. The generated `mise.lock` locks that numeric version, not a rolling channel or a Windows host suffix. Rustup selects each machine's native host (MSVC on Windows; native Linux/macOS in CI). `Cargo.lock` separately locks workspace dependencies.

Refresh consciously: choose the new stable release, update `[tool_alias.rust.versions].stable`, then run `mise lock --bump rust`, inspect the numeric lock readback, and run `mise install --locked rust` plus the quality gates. Do not silently advance stable or commit a host-qualified toolchain into the shared lock. If local installed-version matching selects an old host-suffixed entry, generate the lock with a fresh temporary `MISE_DATA_DIR` and restore that environment variable afterward; this uses the normal mise resolver, not a hand-written lock. Confirm with `mise install --locked --dry-run rust` and `mise exec -- rustc -Vv`.

On Windows, install Visual Studio C++ Build Tools and a Windows SDK and use an x64 developer shell when linking. Use `mise.exe` explicitly if a PowerShell function named `mise` intercepts CLI arguments. The numeric lock does not change rustup's configured default host.

```powershell
mise run fmt
mise run fmt-check
mise run lint
mise run test
mise run pre-commit
```

`fmt` mutates formatting; `fmt-check`, `lint`, and `test` are checks. CI runs the three checks using the same mise tasks on Linux, Windows, and macOS. After installing the generated hook as described below, a commit runs the check-only `pre-commit` task.

## Prompt and usage evaluation

Treat prompt-cache design as an orchestration concern: keep stable instruction and tool-definition prefixes consistent where the harness permits, put changing task details at the end, and pass relevant context as deltas rather than repeating unrelated history. Session reuse is not proof of cache reuse, and compaction may change the prefix. For completed-task comparisons, use a clearly labeled API-equivalent weighted-usage estimate based on measured fresh-input, cached-input, and output counts and the applicable public API rate-card weights for the closest model. Keep the raw counts, model, rate source, and measurement date with the estimate. This is a working comparison model, not a verified ChatGPT Pro billing formula. Compare per-task quality and latency alongside fresh, cached, and output usage; cache percentage alone is not an efficiency result. Read counters only from supported diagnostics, label unavailable measurements as unavailable, and keep cost evaluation in maintainer/evaluation workflows rather than execution instructions. See OpenAI's [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) and [cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics).

## Upstream patch workflow

`upstream.toml` is the authoritative upstream and patch-series pin. `holycodex-dev` uses Git for strict patch application and keeps the upstream checkout outside the HolyCodex tracked tree. It never vendors or commits the upstream source.

```powershell
cargo run --locked -p holycodex-dev -- verify --upstream C:\Users\basile\dev\holycodex-upstream-0.160.1
cargo run --locked -p holycodex-dev -- apply --upstream C:\Users\basile\dev\holycodex-upstream-0.160.1
cargo run --locked -p holycodex-dev -- diff --upstream C:\Users\basile\dev\holycodex-upstream-0.160.1
```

`materialize` clones the manifest repository at the exact commit into `.tmp/upstream` and applies the owned layer; pass `--upstream PATH` to choose a new destination. For an existing pristine checkout, `apply` first verifies the exact commit and requires a clean index/worktree, including untracked files. It snapshots owned sources and preflights **every** destination before any patch mutation, then preflights the patch series with `git apply --check --whitespace=error` and applies without fuzz/reject recovery. Differing existing files, directory conflicts, and symlinks are refused, including ignored destination conflicts. Identical existing source files are left untouched. A second destination preflight after patches catches patch/source collisions. Predictable conflicts cause no mutation; an I/O failure after patch application can still leave partial materialization, so discard/recreate that scratch checkout rather than retrying on a dirty tree.

Materialization copies `crates/holycodex-policy/Cargo.toml`, `src/**`, and optional `build.rs` into the upstream repository's `crates/holycodex-policy`. The complete canonical `overlay/holycodex/**` is copied under upstream `overlay/holycodex`, preserving policy `include_str!("../../../overlay/...")` paths. Skill files are also mapped into `<codex_workspace>/skills/src/assets/samples/**` for native system-skill embedding. No `target`, `generated`, or `.git` directories are copied. The upstream Cargo patch must declare the policy path dependency and update its lockfile; copied sources alone do not wire runtime policy behavior.

`codex_workspace` in `upstream.toml` is a validated portable relative path, used for Cargo, tests, packaging, and runtime skill mapping. `check` and `build` run locked Cargo there. `test` runs `cargo nextest run --no-fail-fast --locked` with the pinned upstream `just test` recipe's `RUST_MIN_STACK=8388608` and `NEXTEST_PROFILE=local`; install native `cargo-nextest` separately. These child commands remove mise's inherited `RUSTUP_TOOLCHAIN` so rustup reads the upstream workspace's own `rust-toolchain.toml` (currently Rust 1.95.0), never the HolyCodex root stable snapshot. `package` builds the pinned CLI and places the same native executable under both compatibility names in `dist/`. No JavaScript runtime is used. Packaging is a local tooling operation, not evidence of a release-ready HolyCodex runtime; complete and verify the runtime identity and behavior patches before distributing artifacts.

To deliberately move the pin, first prepare a clean upstream checkout at the candidate full commit and run `holycodex-dev rebase --revision FULL_COMMIT --upstream PATH`. This explicit operation verifies that revision, uses the same clean-worktree and complete destination preflight, strictly applies the current patches and owned sources to the candidate, and only then updates the manifest. It never fetches or selects a newer release automatically. Tests validate the authoritative manifest, not a permanently frozen initial SHA.

## Pre-commit hook

After `mise install`, install the local check hook with:

```powershell
mise generate git-pre-commit --write --task=pre-commit
```

Hook installation changes Git's local hook configuration and is intentionally a maintainer action. The generated POSIX shell hook runs via Git for Windows' shell and invokes the same native mise task; the existing maintainer-installed hook must not be overwritten by tooling.
