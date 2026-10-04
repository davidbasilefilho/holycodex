//! Owned-source materialization with a complete, non-overwriting preflight.

use std::fs;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, ensure};

pub(super) fn validate_relative(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty()
            && !value.contains(['\\', ':'])
            && value
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
            && Path::new(value)
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "workspace must be a portable, nonempty relative path: {value}"
    );
    Ok(())
}

pub(super) fn validate_directory(root: &Path, relative: &Path) -> Result<()> {
    let root_metadata = fs::symlink_metadata(root)?;
    ensure!(
        root_metadata.is_dir() && !root_metadata.file_type().is_symlink(),
        "receiving root must be a regular directory"
    );
    let mut current = root.to_path_buf();
    for part in relative.components() {
        ensure!(
            matches!(part, Component::Normal(_)),
            "unsafe materialization path"
        );
        current.push(part.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) => ensure!(
                metadata.is_dir() && !metadata.file_type().is_symlink(),
                "destination parent is not a regular directory: {}",
                current.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

fn files(directory: &Path) -> Result<Vec<PathBuf>> {
    let metadata = fs::symlink_metadata(directory)
        .with_context(|| format!("required source {}", directory.display()))?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "source must be a regular directory: {}",
        directory.display()
    );
    let mut pending = vec![directory.to_path_buf()];
    let mut result = Vec::new();
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            if ["target", "generated", ".git"]
                .iter()
                .any(|name| entry.file_name() == *name)
            {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "source symlink is unsupported: {}",
                path.display()
            );
            if metadata.is_dir() {
                pending.push(path);
            } else {
                ensure!(
                    metadata.is_file(),
                    "source is not a regular file: {}",
                    path.display()
                );
                result.push(path);
            }
        }
    }
    result.sort();
    Ok(result)
}

struct File {
    relative: PathBuf,
    contents: Vec<u8>,
    prior: Option<Vec<u8>>,
    replace_owned: bool,
}

/// A byte snapshot whose entire receiving layout is checked before mutation.
pub(super) struct Plan(Vec<File>);

impl Plan {
    pub(super) fn prepare(root: &Path, upstream: &Path, workspace: &str) -> Result<Self> {
        validate_relative(workspace)?;
        let mut plan = Self(Vec::new());
        let policy = root.join("crates/holycodex-policy");
        validate_directory(root, Path::new("crates/holycodex-policy"))?;
        plan.tree(
            &policy.join("src"),
            Path::new("crates/holycodex-policy/src"),
            true,
        )?;
        // Package sources are canonical in this repository; an older materialized
        // copy may be refreshed, but only if it has not changed since planning.
        plan.file(
            &policy.join("Cargo.toml"),
            PathBuf::from("crates/holycodex-policy/Cargo.toml"),
            true,
        )?;
        let codec = root.join("crates/holycodex-toon");
        let policy_manifest: toml::Value =
            toml::from_str(&fs::read_to_string(policy.join("Cargo.toml"))?)
                .context("invalid canonical HolyCodex policy manifest")?;
        let requires_codec = policy_manifest
            .get("dependencies")
            .and_then(|dependencies| dependencies.get("holycodex-toon"))
            .is_some();
        if requires_codec {
            validate_directory(root, Path::new("crates/holycodex-toon"))?;
            plan.tree(&codec, Path::new("crates/holycodex-toon"), true)?;
            let fixtures = Path::new("tests/fixtures/toon");
            validate_directory(root, fixtures)?;
            plan.tree(&root.join(fixtures), fixtures, true)?;
        }
        if policy.join("build.rs").exists() {
            plan.file(
                &policy.join("build.rs"),
                PathBuf::from("crates/holycodex-policy/build.rs"),
                true,
            )?;
        }
        let overlay = root.join("overlay/holycodex");
        validate_directory(root, Path::new("overlay/holycodex"))?;
        plan.tree(&overlay, Path::new("overlay/holycodex"), false)?;
        // Native include_dir assets feed CODEX_HOME/skills/.system at runtime.
        plan.tree(
            &overlay.join("skills"),
            &Path::new(workspace).join("skills/src/assets/samples"),
            false,
        )?;
        plan.capture_prior(upstream)?;
        plan.preflight(upstream)?;
        Ok(plan)
    }

    fn file(&mut self, source: &Path, relative: PathBuf, replace_owned: bool) -> Result<()> {
        let metadata = fs::symlink_metadata(source)?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "source must be a regular file: {}",
            source.display()
        );
        self.bytes(relative, fs::read(source)?, replace_owned);
        Ok(())
    }

    fn bytes(&mut self, relative: PathBuf, contents: Vec<u8>, replace_owned: bool) {
        self.0.push(File {
            relative,
            contents,
            prior: None,
            replace_owned,
        });
    }

    fn tree(&mut self, source: &Path, destination: &Path, replace_owned: bool) -> Result<()> {
        for file in files(source)? {
            self.file(
                &file,
                destination.join(file.strip_prefix(source)?),
                replace_owned,
            )?;
        }
        Ok(())
    }

    fn capture_prior(&mut self, upstream: &Path) -> Result<()> {
        for file in &mut self.0 {
            if !file.replace_owned {
                continue;
            }
            let destination = upstream.join(&file.relative);
            match fs::symlink_metadata(&destination) {
                Ok(metadata) => {
                    ensure!(
                        metadata.is_file() && !metadata.file_type().is_symlink(),
                        "destination is not a regular file: {}",
                        destination.display()
                    );
                    file.prior = Some(fs::read(destination)?);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    fn preflight(&self, upstream: &Path) -> Result<()> {
        for file in &self.0 {
            validate_directory(
                upstream,
                file.relative
                    .parent()
                    .context("missing destination parent")?,
            )?;
            let destination = upstream.join(&file.relative);
            match fs::symlink_metadata(&destination) {
                Ok(metadata) => {
                    ensure!(
                        metadata.is_file() && !metadata.file_type().is_symlink(),
                        "destination is not a regular file: {}",
                        destination.display()
                    );
                    let existing = fs::read(&destination)?;
                    ensure!(
                        existing == file.contents
                            || (file.replace_owned
                                && file.prior.as_ref().is_some_and(|prior| prior == &existing)),
                        "refusing to overwrite differing destination: {}",
                        destination.display()
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => ensure!(
                    file.prior.is_none(),
                    "destination disappeared after materialization planning: {}",
                    destination.display()
                ),
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    pub(super) fn install(self, upstream: &Path) -> Result<()> {
        // Patches must not have introduced a new destination conflict either.
        self.preflight(upstream)?;
        for file in self.0 {
            let destination = upstream.join(file.relative);
            match fs::symlink_metadata(&destination) {
                Ok(_) if fs::read(&destination)? == file.contents => continue,
                Ok(_) if file.replace_owned => {
                    fs::write(&destination, &file.contents)?;
                    continue;
                }
                Ok(_) => unreachable!("preflight rejected differing unowned destination"),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            fs::create_dir_all(destination.parent().context("missing destination parent")?)?;
            use std::io::Write;
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)?;
            output.write_all(&file.contents)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn materializes_canonical_policy_codec_without_rewriting_workspace_manifest() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let upstream = tempdir().unwrap();
        let workspace = upstream.path().join("codex-rs");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(
            workspace.join("Cargo.toml"),
            "[workspace]\nmembers = []\nresolver = \"2\"\n",
        )
        .unwrap();

        Plan::prepare(&root, upstream.path(), "codex-rs")
            .unwrap()
            .install(upstream.path())
            .unwrap();

        let policy = upstream
            .path()
            .join("crates/holycodex-policy/src/formats.rs");
        let policy_api = upstream.path().join("crates/holycodex-policy/src/lib.rs");
        let codec = upstream.path().join("crates/holycodex-toon/Cargo.toml");
        let fixtures = upstream.path().join("tests/fixtures/toon/metadata.toml");
        assert!(policy.is_file());
        let policy_source = fs::read_to_string(policy_api).unwrap();
        assert!(policy_source.contains("pub struct CapabilityConfig"));
        assert!(policy_source.contains("pub struct PolicyOptions"));
        assert!(codec.is_file());
        assert!(fixtures.is_file());
        let fixture_root = upstream
            .path()
            .join("crates/holycodex-toon/../../tests/fixtures/toon");
        assert!(fixture_root.join("encode/objects.json").is_file());
        assert!(fixture_root.join("decode/validation-errors.json").is_file());
        assert_eq!(files(&fixture_root).unwrap().len(), 24);
        assert!(
            upstream
                .path()
                .join("overlay/holycodex/instructions")
                .is_dir()
        );
        assert_eq!(
            fs::read(workspace.join("Cargo.toml")).unwrap(),
            b"[workspace]\nmembers = []\nresolver = \"2\"\n"
        );

        // A second installation is idempotent and does not touch an existing
        // upstream-owned runtime/controller file.
        let protected = upstream.path().join("codex-rs/src/runtime-controller.rs");
        fs::create_dir_all(protected.parent().unwrap()).unwrap();
        fs::File::create(&protected)
            .unwrap()
            .write_all(b"owned elsewhere")
            .unwrap();
        Plan::prepare(&root, upstream.path(), "codex-rs")
            .unwrap()
            .install(upstream.path())
            .unwrap();
        assert_eq!(fs::read(protected).unwrap(), b"owned elsewhere");
    }

    #[test]
    fn owned_package_refresh_refuses_post_plan_change() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let upstream = tempdir().unwrap();
        fs::create_dir_all(upstream.path().join("crates/holycodex-policy/src")).unwrap();
        fs::write(
            upstream
                .path()
                .join("crates/holycodex-policy/src/formats.rs"),
            "old owned snapshot",
        )
        .unwrap();
        let plan = Plan::prepare(&root, upstream.path(), "codex-rs").unwrap();
        fs::write(
            upstream
                .path()
                .join("crates/holycodex-policy/src/formats.rs"),
            "concurrent controller change",
        )
        .unwrap();
        assert!(plan.install(upstream.path()).is_err());
        assert_eq!(
            fs::read_to_string(
                upstream
                    .path()
                    .join("crates/holycodex-policy/src/formats.rs")
            )
            .unwrap(),
            "concurrent controller change"
        );
    }
}
