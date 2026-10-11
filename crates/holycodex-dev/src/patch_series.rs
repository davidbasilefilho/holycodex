//! Ordered patch preflight without changing the receiving worktree or index.
use anyhow::{Context, Result, ensure};
use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

struct ScratchIndex {
    directory: tempfile::TempDir,
    alternates: OsString,
}

impl ScratchIndex {
    fn new(upstream: &Path) -> Result<Self> {
        let objects = Command::new("git")
            .args([
                "rev-parse",
                "--path-format=absolute",
                "--git-path",
                "objects",
            ])
            .current_dir(upstream)
            .output()?;
        ensure!(
            objects.status.success(),
            "cannot locate upstream Git objects"
        );
        let objects = PathBuf::from(String::from_utf8(objects.stdout)?.trim());
        let directory = tempfile::tempdir()?;
        fs::create_dir(directory.path().join("objects"))?;
        let index = Self {
            directory,
            alternates: std::env::join_paths([objects])?,
        };
        index.run(upstream, &[OsStr::new("read-tree"), OsStr::new("HEAD")])?;
        Ok(index)
    }

    fn run(&self, upstream: &Path, args: &[&OsStr]) -> Result<()> {
        self.output(upstream, args).map(|_| ())
    }

    fn output(&self, upstream: &Path, args: &[&OsStr]) -> Result<Vec<u8>> {
        let output = Command::new("git")
            .args(args)
            .current_dir(upstream)
            .env("GIT_INDEX_FILE", self.directory.path().join("index"))
            .env(
                "GIT_OBJECT_DIRECTORY",
                self.directory.path().join("objects"),
            )
            .env("GIT_ALTERNATE_OBJECT_DIRECTORIES", &self.alternates)
            .output()?;
        ensure!(
            output.status.success(),
            "patch-series Git operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        Ok(output.stdout)
    }
}

pub(crate) fn apply(upstream: &Path, patches: &[PathBuf]) -> Result<()> {
    if patches.is_empty() {
        return Ok(());
    }
    // Later patches may edit files created by earlier patches. Stage their
    // effects only in a private index/object store while checking the series.
    let scratch = ScratchIndex::new(upstream)?;
    for patch in patches {
        scratch
            .run(
                upstream,
                &[
                    OsStr::new("apply"),
                    OsStr::new("--cached"),
                    OsStr::new("--check"),
                    OsStr::new("--whitespace=error"),
                    OsStr::new("--exclude=*.snap"),
                    OsStr::new("--"),
                    patch.as_os_str(),
                ],
            )
            .context("strict non-snapshot patch preflight failed; no patch was applied")?;
        scratch
            .run(
                upstream,
                &[
                    OsStr::new("apply"),
                    OsStr::new("--cached"),
                    OsStr::new("--whitespace=nowarn"),
                    OsStr::new("--"),
                    patch.as_os_str(),
                ],
            )
            .context("patch applicability preflight failed; no patch was applied")?;
    }
    for patch in patches {
        super::git(
            &[
                OsStr::new("apply"),
                OsStr::new("--whitespace=nowarn"),
                OsStr::new("--"),
                patch.as_os_str(),
            ],
            upstream,
        )
        .context("applying ordered patch series")?;
    }
    Ok(())
}

pub(crate) fn verify(upstream: &Path, patches: &[PathBuf]) -> Result<()> {
    ensure!(
        !patches.is_empty(),
        "HolyCodex patch layer is empty; refusing to package upstream Codex"
    );
    let scratch = ScratchIndex::new(upstream)?;
    // Derive the exact touched paths from Git's index changes. Build postimages
    // in private storage first, including files ignored by the user's config.
    // Keep intermediate paths too: a later patch can undo or delete an earlier
    // addition, and unexpected files at those paths must still fail verification.
    let mut touched = BTreeSet::new();
    for patch in patches {
        scratch.run(
            upstream,
            &[
                OsStr::new("apply"),
                OsStr::new("--cached"),
                OsStr::new("--whitespace=nowarn"),
                OsStr::new("--"),
                patch.as_os_str(),
            ],
        )?;
        let paths = scratch.output(
            upstream,
            &[
                OsStr::new("diff"),
                OsStr::new("--cached"),
                OsStr::new("--name-only"),
                OsStr::new("--no-renames"),
                OsStr::new("-z"),
                OsStr::new("HEAD"),
                OsStr::new("--"),
            ],
        )?;
        for path in paths
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let path = std::str::from_utf8(path)?;
            super::materialization::validate_relative(path)?;
            touched.insert(PathBuf::from(path));
        }
    }
    refresh_patch_targets(&scratch, upstream, &touched)?;
    for patch in patches.iter().rev() {
        scratch
            .run(
                upstream,
                &[
                    OsStr::new("apply"),
                    OsStr::new("--cached"),
                    OsStr::new("--reverse"),
                    OsStr::new("--whitespace=nowarn"),
                    OsStr::new("--"),
                    patch.as_os_str(),
                ],
            )
            .context("HolyCodex patch series is not fully applied; materialize before packaging")?;
    }
    Ok(())
}

fn refresh_patch_targets(
    scratch: &ScratchIndex,
    upstream: &Path,
    touched: &BTreeSet<PathBuf>,
) -> Result<()> {
    for path in touched {
        match fs::symlink_metadata(upstream.join(path)) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_file() || metadata.file_type().is_symlink(),
                    "patch target is not a file: {}",
                    path.display()
                );
                // A literal, explicit file path prevents wildcard expansion and
                // avoids importing unrelated ignored files into scratch storage.
                scratch.run(
                    upstream,
                    &[
                        OsStr::new("--literal-pathspecs"),
                        OsStr::new("add"),
                        OsStr::new("--force"),
                        OsStr::new("--"),
                        path.as_os_str(),
                    ],
                )?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                scratch.run(
                    upstream,
                    &[
                        OsStr::new("update-index"),
                        OsStr::new("--force-remove"),
                        OsStr::new("--"),
                        path.as_os_str(),
                    ],
                )?;
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf, Vec<PathBuf>) {
        let dir = tempfile::tempdir().unwrap();
        let upstream = dir.path().join("upstream");
        fs::create_dir(&upstream).unwrap();
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "core.autocrlf", "false"],
            vec![
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        ] {
            super::super::git(&args.iter().map(OsStr::new).collect::<Vec<_>>(), &upstream).unwrap();
        }
        let first = dir.path().join("0001.patch");
        let second = dir.path().join("0002.patch");
        fs::write(&first, "diff --git a/new.rs b/new.rs\nnew file mode 100644\n--- /dev/null\n+++ b/new.rs\n@@ -0,0 +1 @@\n+first\n").unwrap();
        fs::write(&second, "diff --git a/new.rs b/new.rs\n--- a/new.rs\n+++ b/new.rs\n@@ -1 +1 @@\n-first\n+second\n").unwrap();
        (dir, upstream, vec![first, second])
    }

    #[test]
    fn dependent_series_applies_and_verifies_without_changing_real_index() {
        let (_dir, upstream, patches) = fixture();
        let index = upstream.join(".git/index");
        let before = fs::read(&index).ok();
        apply(&upstream, &patches).unwrap();
        assert_eq!(
            fs::read_to_string(upstream.join("new.rs")).unwrap(),
            "second\n"
        );
        fs::write(upstream.join("overlay.txt"), "owned overlay").unwrap();
        verify(&upstream, &patches).unwrap();
        assert_eq!(fs::read(&index).ok(), before);
        assert_eq!(
            fs::read_to_string(upstream.join("overlay.txt")).unwrap(),
            "owned overlay"
        );
        fs::write(upstream.join("new.rs"), "corrupted\n").unwrap();
        assert!(verify(&upstream, &patches).is_err());
    }

    #[test]
    fn verification_includes_ignored_patch_targets_and_rejects_missing_or_corrupt_bytes() {
        let (_dir, upstream, patches) = fixture();
        fs::write(upstream.join(".git/info/exclude"), "*.rs\n").unwrap();
        apply(&upstream, &patches).unwrap();
        verify(&upstream, &patches).unwrap();
        fs::write(upstream.join("new.rs"), "corrupted\n").unwrap();
        assert!(verify(&upstream, &patches).is_err());
        fs::remove_file(upstream.join("new.rs")).unwrap();
        assert!(verify(&upstream, &patches).is_err());
    }

    #[test]
    fn verification_handles_crlf_without_changing_worktree_bytes() {
        let (_dir, upstream, patches) = fixture();
        super::super::git(
            &[
                OsStr::new("config"),
                OsStr::new("core.autocrlf"),
                OsStr::new("true"),
            ],
            &upstream,
        )
        .unwrap();
        apply(&upstream, &patches).unwrap();
        let bytes = fs::read(upstream.join("new.rs")).unwrap();
        assert_eq!(bytes, b"second\r\n");
        verify(&upstream, &patches).unwrap();
        assert_eq!(fs::read(upstream.join("new.rs")).unwrap(), bytes);
    }

    #[test]
    fn verification_checks_intermediate_deleted_ignored_paths_without_importing_other_files() {
        let (dir, upstream, mut patches) = fixture();
        fs::write(upstream.join(".git/info/exclude"), "*.rs\n").unwrap();
        let third = dir.path().join("0003.patch");
        fs::write(&third, "diff --git a/new.rs b/new.rs\ndeleted file mode 100644\n--- a/new.rs\n+++ /dev/null\n@@ -1 +0,0 @@\n-second\n").unwrap();
        patches.push(third);
        apply(&upstream, &patches).unwrap();
        fs::write(upstream.join("unrelated.rs"), "unrelated ignored content").unwrap();
        verify(&upstream, &patches).unwrap();
        fs::write(upstream.join("new.rs"), "second\n").unwrap();
        assert!(verify(&upstream, &patches).is_err());
        fs::remove_file(upstream.join("new.rs")).unwrap();
        fs::create_dir(upstream.join("new.rs")).unwrap();
        assert!(verify(&upstream, &patches).is_err());
        let scratch = ScratchIndex::new(&upstream).unwrap();
        fs::write(upstream.join("explicit.rs"), "patch target").unwrap();
        let touched = [PathBuf::from("explicit.rs")].into();
        refresh_patch_targets(&scratch, &upstream, &touched).unwrap();
        let listed = scratch
            .output(&upstream, &[OsStr::new("ls-files"), OsStr::new("-z")])
            .unwrap();
        assert_eq!(listed, b"explicit.rs\0");
    }

    #[test]
    fn invalid_later_patch_leaves_receiving_tree_pristine() {
        let (_dir, upstream, patches) = fixture();
        let second = fs::read_to_string(&patches[1])
            .unwrap()
            .replace("-first", "-missing");
        fs::write(&patches[1], second).unwrap();
        assert!(apply(&upstream, &patches).is_err());
        assert!(!upstream.join("new.rs").exists());
        super::super::verify_clean_worktree(&upstream).unwrap();
    }

    #[test]
    fn snapshot_only_series_preserves_intentional_whitespace() {
        let (_dir, upstream, patches) = fixture();
        for patch in &patches {
            let body = fs::read_to_string(patch)
                .unwrap()
                .replace("new.rs", "render.snap")
                .replace("+second", "+second ");
            fs::write(patch, body).unwrap();
        }
        apply(&upstream, &patches).unwrap();
        assert_eq!(
            fs::read_to_string(upstream.join("render.snap")).unwrap(),
            "second \n"
        );
        verify(&upstream, &patches).unwrap();
    }

    #[test]
    fn later_non_snapshot_whitespace_is_still_rejected() {
        let (_dir, upstream, patches) = fixture();
        let second = fs::read_to_string(&patches[1])
            .unwrap()
            .replace("+second", "+second ");
        fs::write(&patches[1], second).unwrap();
        assert!(apply(&upstream, &patches).is_err());
        assert!(!upstream.join("new.rs").exists());
    }
}
