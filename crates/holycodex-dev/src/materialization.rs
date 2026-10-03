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
}

/// A byte snapshot whose entire receiving layout is checked before mutation.
pub(super) struct Plan(Vec<File>);

impl Plan {
    pub(super) fn prepare(root: &Path, upstream: &Path, workspace: &str) -> Result<Self> {
        validate_relative(workspace)?;
        let mut plan = Self(Vec::new());
        let policy = root.join("crates/holycodex-policy");
        validate_directory(root, Path::new("crates/holycodex-policy"))?;
        plan.file(
            &policy.join("Cargo.toml"),
            PathBuf::from("crates/holycodex-policy/Cargo.toml"),
        )?;
        plan.tree(
            &policy.join("src"),
            Path::new("crates/holycodex-policy/src"),
        )?;
        if policy.join("build.rs").exists() {
            plan.file(
                &policy.join("build.rs"),
                PathBuf::from("crates/holycodex-policy/build.rs"),
            )?;
        }
        let overlay = root.join("overlay/holycodex");
        validate_directory(root, Path::new("overlay/holycodex"))?;
        plan.tree(&overlay, Path::new("overlay/holycodex"))?;
        // Native include_dir assets feed CODEX_HOME/skills/.system at runtime.
        plan.tree(
            &overlay.join("skills"),
            &Path::new(workspace).join("skills/src/assets/samples"),
        )?;
        plan.preflight(upstream)?;
        Ok(plan)
    }

    fn file(&mut self, source: &Path, relative: PathBuf) -> Result<()> {
        let metadata = fs::symlink_metadata(source)?;
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "source must be a regular file: {}",
            source.display()
        );
        self.0.push(File {
            relative,
            contents: fs::read(source)?,
        });
        Ok(())
    }

    fn tree(&mut self, source: &Path, destination: &Path) -> Result<()> {
        for file in files(source)? {
            self.file(&file, destination.join(file.strip_prefix(source)?))?;
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
                    ensure!(
                        fs::read(&destination)? == file.contents,
                        "refusing to overwrite differing destination: {}",
                        destination.display()
                    );
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
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
            if destination.exists() {
                continue; // Identical bytes only; never truncate an existing file.
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
