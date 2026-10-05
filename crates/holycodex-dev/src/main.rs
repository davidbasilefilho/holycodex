#![forbid(unsafe_code)]

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, ExitStatus};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};

const DEFAULT_UPSTREAM: &str = ".tmp/upstream";
mod materialization;

#[derive(Parser)]
#[command(
    name = "holycodex-dev",
    about = "HolyCodex upstream patch/build tooling"
)]
struct Cli {
    #[command(subcommand)]
    command: Operation,
}

#[derive(Subcommand)]
enum Operation {
    /// Clone the exact manifest revision and apply patches plus owned sources.
    Materialize {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
    },
    /// Verify that an existing upstream checkout is exactly the manifest pin.
    Verify {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
    },
    /// Apply the complete strict patch series followed by regular-file overlays.
    Apply {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
    },
    /// Run locked Cargo check in the pinned upstream Rust workspace.
    Check {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
    },
    /// Build the pinned upstream Rust workspace.
    Build {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
        #[arg(long)]
        release: bool,
    },
    /// Test the pinned upstream using its repository test runner.
    Test {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
    },
    /// Build the native Codex CLI and package the same executable under both names.
    Package {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
        #[arg(long, default_value = "dist")]
        output: PathBuf,
        #[arg(long)]
        release: bool,
    },
    /// Show the upstream tracked diff and untracked overlay/patch paths.
    Diff {
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
    },
    /// Explicitly change the pin after verifying a prepared full-commit checkout.
    Rebase {
        #[arg(long)]
        revision: String,
        #[arg(long)]
        release: Option<String>,
        #[arg(long, default_value = DEFAULT_UPSTREAM)]
        upstream: PathBuf,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Manifest {
    holycodex_version: String,
    repository: String,
    commit: String,
    release: String,
    patch_series_format: u32,
    codex_workspace: String,
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn manifest(root: &Path) -> Result<Manifest> {
    let path = root.join("upstream.toml");
    let source =
        fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    let value: Manifest = toml::from_str(&source).context("parsing upstream.toml")?;
    ensure!(
        value.patch_series_format == 1,
        "unsupported patch-series format {}",
        value.patch_series_format
    );
    ensure!(
        valid_revision(&value.commit),
        "manifest pin must be a full 40-character commit SHA"
    );
    materialization::validate_relative(&value.codex_workspace)?;
    Ok(value)
}

fn valid_revision(revision: &str) -> bool {
    revision.len() == 40 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn absolute_from(root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }
}

fn pinned_toolchain_bin(cwd: &Path) -> Result<PathBuf> {
    let config = cwd.join("rust-toolchain.toml");
    let source = fs::read_to_string(&config)
        .with_context(|| format!("reading upstream toolchain pin {}", config.display()))?;
    let value: toml::Value = toml::from_str(&source).context("parsing upstream toolchain pin")?;
    let channel = value["toolchain"]["channel"]
        .as_str()
        .context("upstream toolchain pin is missing toolchain.channel")?;
    let output = ProcessCommand::new("rustup")
        .args(["which", "--toolchain", channel, "cargo"])
        .output()
        .context("locating pinned upstream Cargo with rustup")?;
    ensure!(
        output.status.success(),
        "rustup could not locate pinned upstream Cargo: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let cargo = PathBuf::from(
        String::from_utf8(output.stdout)
            .context("rustup returned a non-UTF-8 Cargo path")?
            .trim(),
    );
    let bin = cargo
        .parent()
        .context("rustup returned a Cargo path without a parent directory")?;
    ensure!(
        cargo.is_file(),
        "pinned Cargo is missing at {}",
        cargo.display()
    );
    Ok(bin.to_path_buf())
}

fn set_pinned_path(command: &mut ProcessCommand, bin: PathBuf, inherited: OsString) -> Result<()> {
    let mut paths = vec![bin];
    paths.extend(std::env::split_paths(&inherited));
    let path = std::env::join_paths(paths).context("building pinned upstream PATH")?;
    command.env("PATH", path);
    Ok(())
}

fn child_command_with_toolchain_bin(
    program: &OsStr,
    args: &[&OsStr],
    cwd: &Path,
    toolchain_bin: Option<PathBuf>,
) -> Result<ProcessCommand> {
    let executable = if program == OsStr::new("cargo") {
        let bin = toolchain_bin
            .as_ref()
            .context("missing pinned upstream toolchain bin")?;
        bin.join(if cfg!(windows) { "cargo.exe" } else { "cargo" })
    } else {
        PathBuf::from(program)
    };
    let mut command = ProcessCommand::new(executable);
    command.args(args).current_dir(cwd);
    if program == OsStr::new("cargo") || program == OsStr::new("just") {
        // Put the actual rustup-managed toolchain binaries ahead of mise's PATH
        // entries; removing RUSTUP_TOOLCHAIN alone cannot affect direct binaries.
        command.env_remove("RUSTUP_TOOLCHAIN");
        let bin = toolchain_bin.context("missing pinned upstream toolchain bin")?;
        let inherited = std::env::var_os("PATH").unwrap_or_default();
        set_pinned_path(&mut command, bin, inherited)?;
    }
    if program == OsStr::new("cargo") && args.first() == Some(&OsStr::new("nextest")) {
        command
            .env("RUST_MIN_STACK", "8388608")
            .env("NEXTEST_PROFILE", "local");
    }
    Ok(command)
}

fn child_command(program: &OsStr, args: &[&OsStr], cwd: &Path) -> Result<ProcessCommand> {
    let toolchain_bin = if program == OsStr::new("cargo") || program == OsStr::new("just") {
        Some(pinned_toolchain_bin(cwd)?)
    } else {
        None
    };
    child_command_with_toolchain_bin(program, args, cwd, toolchain_bin)
}

fn run(program: &OsStr, args: &[&OsStr], cwd: &Path) -> Result<ExitStatus> {
    let status = child_command(program, args, cwd)?
        .status()
        .with_context(|| format!("starting {}", program.to_string_lossy()))?;
    ensure!(
        status.success(),
        "{} failed with {status}",
        program.to_string_lossy()
    );
    Ok(status)
}

fn git(args: &[&OsStr], cwd: &Path) -> Result<()> {
    run(OsStr::new("git"), args, cwd).map(|_| ())
}

fn git_output(args: &[&OsStr], cwd: &Path) -> Result<String> {
    let output = ProcessCommand::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .context("starting git")?;
    ensure!(
        output.status.success(),
        "git {} failed: {}",
        args.first().unwrap_or(&OsStr::new("")).to_string_lossy(),
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(String::from_utf8(output.stdout)
        .context("git returned non-UTF-8 output")?
        .trim()
        .to_owned())
}

fn verify_checkout(path: &Path, expected: &str) -> Result<()> {
    let actual = git_output(
        &[OsStr::new("rev-parse"), OsStr::new("HEAD^{commit}")],
        path,
    )?;
    ensure!(
        actual == expected,
        "upstream revision mismatch: expected {expected}, found {actual}"
    );
    Ok(())
}

fn verify_clean_worktree(path: &Path) -> Result<()> {
    let status = git_output(
        &[
            OsStr::new("status"),
            OsStr::new("--porcelain=v1"),
            OsStr::new("--untracked-files=all"),
        ],
        path,
    )?;
    ensure!(
        status.is_empty(),
        "receiving upstream worktree must be clean, including untracked files:\n{status}"
    );
    Ok(())
}

fn apply_layer(root: &Path, upstream: &Path, pin: &Manifest) -> Result<()> {
    verify_clean_worktree(upstream)?;
    // Snapshot sources and validate EVERY destination before any patch mutation.
    let plan = materialization::Plan::prepare(root, upstream, &pin.codex_workspace)?;
    apply_patches(root, upstream)?;
    plan.install(upstream)
}

fn patch_files(root: &Path) -> Result<Vec<PathBuf>> {
    let directory = root.join("patches");
    if !directory.exists() {
        return Ok(Vec::new());
    }
    ensure!(
        !fs::symlink_metadata(&directory)?.file_type().is_symlink(),
        "patch directory must not be a symlink"
    );
    let mut files = fs::read_dir(&directory)
        .with_context(|| format!("reading {}", directory.display()))?
        .map(|entry| entry.map(|item| item.path()).context("reading patch entry"))
        .collect::<Result<Vec<_>>>()?;
    files.retain(|path| path.extension().is_some_and(|ext| ext == "patch"));
    files.sort();
    for file in &files {
        let metadata = fs::symlink_metadata(file)?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "patch must be a regular file: {}",
            file.display()
        );
    }
    Ok(files)
}

fn apply_patches(root: &Path, upstream: &Path) -> Result<()> {
    let patches = patch_files(root)?;
    if patches.is_empty() {
        return Ok(());
    }
    let paths = patches
        .iter()
        .map(|path| path.as_os_str())
        .collect::<Vec<_>>();
    let mut check_args = vec![
        OsStr::new("apply"),
        OsStr::new("--check"),
        OsStr::new("--whitespace=error"),
        OsStr::new("--"),
    ];
    check_args.extend(paths.iter().copied());
    git(&check_args, upstream).context("strict patch preflight failed; no patch was applied")?;
    let mut apply_args = vec![
        OsStr::new("apply"),
        OsStr::new("--whitespace=error"),
        OsStr::new("--"),
    ];
    apply_args.extend(paths);
    git(&apply_args, upstream).context("applying strict patch series")
}

fn workspace(upstream: &Path, pin: &Manifest) -> Result<PathBuf> {
    materialization::validate_relative(&pin.codex_workspace)?;
    let workspace = upstream.join(&pin.codex_workspace);
    materialization::validate_directory(upstream, Path::new(&pin.codex_workspace))?;
    ensure!(
        workspace.join("Cargo.toml").is_file(),
        "missing pinned Codex Rust workspace at {}",
        workspace.display()
    );
    Ok(workspace)
}

fn cargo(upstream: &Path, pin: &Manifest, args: &[&OsStr]) -> Result<()> {
    run(OsStr::new("cargo"), args, &workspace(upstream, pin)?).map(|_| ())
}
fn execute(operation: Operation, root: &Path) -> Result<()> {
    let mut pin = manifest(root)?;
    match operation {
        Operation::Materialize { upstream } => {
            let upstream = absolute_from(root, &upstream);
            ensure!(
                !upstream.exists(),
                "destination already exists: {}",
                upstream.display()
            );
            if let Some(parent) = upstream.parent() {
                fs::create_dir_all(parent)?;
            }
            git(
                &[
                    OsStr::new("clone"),
                    OsStr::new("--no-checkout"),
                    OsStr::new(&pin.repository),
                    upstream.as_os_str(),
                ],
                root,
            )?;
            git(
                &[
                    OsStr::new("checkout"),
                    OsStr::new("--detach"),
                    OsStr::new(&pin.commit),
                ],
                &upstream,
            )?;
            verify_checkout(&upstream, &pin.commit)?;
            apply_layer(root, &upstream, &pin)?;
            println!("materialized {} at {}", pin.commit, upstream.display());
        }
        Operation::Verify { upstream } => {
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &pin.commit)?;
            println!("verified {} at {}", pin.commit, upstream.display());
        }
        Operation::Apply { upstream } => {
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &pin.commit)?;
            apply_layer(root, &upstream, &pin)?;
            println!(
                "applied patch series and overlays to {}",
                upstream.display()
            );
        }
        Operation::Check { upstream } => {
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &pin.commit)?;
            cargo(
                &upstream,
                &pin,
                &[
                    OsStr::new("check"),
                    OsStr::new("--workspace"),
                    OsStr::new("--locked"),
                ],
            )?;
        }
        Operation::Build { upstream, release } => {
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &pin.commit)?;
            let mut args = vec![
                OsStr::new("build"),
                OsStr::new("--workspace"),
                OsStr::new("--locked"),
            ];
            if release {
                args.push(OsStr::new("--release"));
            }
            cargo(&upstream, &pin, &args)?;
        }
        Operation::Test { upstream } => {
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &pin.commit)?;
            // Match the pinned just test recipe without its hardcoded workspace path.
            cargo(
                &upstream,
                &pin,
                &[
                    OsStr::new("nextest"),
                    OsStr::new("run"),
                    OsStr::new("--no-fail-fast"),
                    OsStr::new("--locked"),
                ],
            )?;
        }
        Operation::Package {
            upstream,
            output,
            release,
        } => {
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &pin.commit)?;
            let mut args = vec![
                OsStr::new("build"),
                OsStr::new("--locked"),
                OsStr::new("-p"),
                OsStr::new("codex-cli"),
            ];
            if release {
                args.push(OsStr::new("--release"));
            }
            cargo(&upstream, &pin, &args)?;
            let profile = if release { "release" } else { "debug" };
            let binary = upstream
                .join(&pin.codex_workspace)
                .join("target")
                .join(profile)
                .join(if cfg!(windows) { "codex.exe" } else { "codex" });
            ensure!(
                binary.is_file(),
                "build did not produce {}",
                binary.display()
            );
            let output = absolute_from(root, &output);
            fs::create_dir_all(&output)?;
            for name in [
                if cfg!(windows) {
                    "holycodex.exe"
                } else {
                    "holycodex"
                },
                if cfg!(windows) { "codex.exe" } else { "codex" },
            ] {
                fs::copy(&binary, output.join(name))
                    .with_context(|| format!("packaging {name}"))?;
            }
            println!(
                "packaged one native binary under holycodex and codex in {}",
                output.display()
            );
        }
        Operation::Diff { upstream } => {
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &pin.commit)?;
            git(
                &[OsStr::new("diff"), OsStr::new("--stat"), OsStr::new("HEAD")],
                &upstream,
            )?;
            git(
                &[
                    OsStr::new("status"),
                    OsStr::new("--short"),
                    OsStr::new("--untracked-files=all"),
                ],
                &upstream,
            )?;
        }
        Operation::Rebase {
            revision,
            release,
            upstream,
        } => {
            ensure!(
                valid_revision(&revision),
                "--revision must be a full 40-character commit SHA"
            );
            let upstream = absolute_from(root, &upstream);
            verify_checkout(&upstream, &revision)?;
            apply_layer(root, &upstream, &pin)
                .context("candidate revision does not accept the patch series and owned sources")?;
            pin.commit = revision;
            pin.release = release.unwrap_or_else(|| "unreleased".into());
            let serialized =
                toml::to_string_pretty(&pin).context("serializing upstream manifest")?;
            fs::write(root.join("upstream.toml"), serialized).context("writing upstream pin")?;
            println!(
                "updated upstream pin to {}; review patch and overlay compatibility",
                pin.commit
            );
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let root = root();
    execute(Cli::parse().command, &root)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
