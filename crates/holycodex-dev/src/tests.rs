use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail, ensure};
use tempfile::tempdir;

use crate::materialization::{Plan, validate_relative};
use crate::{apply_patches, manifest, valid_revision, verify_checkout, verify_clean_worktree};

fn collect_skill_files(directory: &Path, files: &mut Vec<PathBuf>) -> std::io::Result<()> {
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            collect_skill_files(&entry.path(), files)?;
        } else if file_type.is_file() && entry.file_name() == "SKILL.md" {
            files.push(entry.path());
        }
    }
    Ok(())
}

fn skill_metadata(source: &str) -> Result<(&str, &str)> {
    let mut lines = source
        .lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line));
    ensure!(
        lines.next() == Some("---"),
        "missing opening YAML frontmatter"
    );

    let mut name = None;
    let mut description = None;
    let mut closed = false;
    for line in lines {
        if line == "---" {
            closed = true;
            break;
        }
        let (key, value) = line
            .split_once(": ")
            .context("frontmatter must use supported plain scalar fields")?;
        ensure!(
            !value.is_empty() && value.trim() == value,
            "empty or ambiguous scalar"
        );
        ensure!(
            !value.chars().next().is_some_and(|ch| matches!(
                ch,
                '\'' | '"'
                    | '['
                    | '{'
                    | '|'
                    | '>'
                    | '&'
                    | '*'
                    | '!'
                    | '?'
                    | '#'
                    | '%'
                    | '@'
                    | '`'
                    | '-'
            )) && !value.contains(": ")
                && !value.contains(" #"),
            "unsupported or ambiguous YAML scalar"
        );
        match key {
            "name" => {
                ensure!(name.is_none(), "duplicate name field");
                ensure!(
                    value
                        .chars()
                        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-'),
                    "name must be a lowercase skill identifier"
                );
                name = Some(value);
            }
            "description" => {
                ensure!(description.is_none(), "duplicate description field");
                description = Some(value);
            }
            _ => bail!("unsupported frontmatter field: {key}"),
        }
    }
    ensure!(closed, "missing closing YAML frontmatter");
    let name = name.context("missing name field")?;
    let description = description.context("missing description field")?;
    ensure!(
        description
            .strip_prefix("Use ")
            .is_some_and(|trigger| !trigger.trim().is_empty()),
        "description must begin with `Use ` and name a trigger"
    );
    Ok((name, description))
}

#[test]
fn every_canonical_skill_has_supported_frontmatter_and_a_use_trigger() {
    let root = crate::root().join("overlay/holycodex/skills");
    let mut skills = Vec::new();
    collect_skill_files(&root, &mut skills).unwrap();
    assert!(
        !skills.is_empty(),
        "no canonical skills found under {}",
        root.display()
    );

    for path in skills {
        let source = fs::read_to_string(&path).unwrap();
        let (name, _) = skill_metadata(&source)
            .with_context(|| format!("invalid skill metadata in {}", path.display()))
            .unwrap();
        assert_eq!(
            path.parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str()),
            Some(name),
            "skill name must match its directory: {}",
            path.display()
        );
    }
}

#[test]
fn skill_frontmatter_rejects_missing_unsupported_and_non_use_metadata() {
    let root = tempdir().unwrap();
    let skill = root.path().join("SKILL.md");
    for source in [
        "---\nname: new-skill\ndescription: A skill. Use when needed.\n---\n",
        "---\nname: new-skill\ndescription: Use when needed.\nextra: value\n---\n",
        "---\nname: new-skill\ndescription: 'Use when needed.'\n---\n",
        "---\nname: new-skill\ndescription: Use when needed.\ndescription: Use again.\n---\n",
        "---\nname: new-skill\ndescription: Use when needed.\n",
    ] {
        fs::write(&skill, source).unwrap();
        let contents = fs::read_to_string(&skill).unwrap();
        assert!(
            skill_metadata(&contents).is_err(),
            "accepted invalid metadata: {source}"
        );
    }
}

#[test]
fn manifest_matches_authoritative_source_and_allows_deliberate_rebase() {
    let root = crate::root();
    let parsed = manifest(&root).unwrap();
    let source: toml::Value =
        toml::from_str(&fs::read_to_string(root.join("upstream.toml")).unwrap()).unwrap();
    assert_eq!(parsed.commit, source["commit"].as_str().unwrap());
    assert_eq!(
        parsed.codex_workspace,
        source["codex_workspace"].as_str().unwrap()
    );
    assert!(valid_revision(&parsed.commit));
    assert_eq!(parsed.repository, "https://github.com/openai/codex.git");
}

#[test]
fn revisions_must_be_full_hex_commits() {
    assert!(valid_revision("a956835d020762cb2b570053af06f643a11c0ecc"));
    assert!(!valid_revision("a956835"));
    assert!(!valid_revision("g956835d020762cb2b570053af06f643a11c0ecc"));
}

#[test]
fn workspace_paths_are_portable_and_cannot_escape() {
    assert!(validate_relative("native/rust").is_ok());
    for path in [
        "",
        "/rust",
        "../rust",
        "native/../rust",
        "C:/rust",
        "native\\rust",
        "./rust",
        "native//rust",
    ] {
        assert!(validate_relative(path).is_err(), "{path}");
    }
}

#[test]
fn upstream_runner_removes_root_toolchain_override_and_matches_nextest_recipe() {
    use std::ffi::OsStr;
    let command = crate::child_command(
        OsStr::new("cargo"),
        &[OsStr::new("nextest")],
        std::path::Path::new("native/rust"),
    );
    assert_eq!(
        command.get_current_dir(),
        Some(std::path::Path::new("native/rust"))
    );
    let environment: std::collections::HashMap<_, _> = command.get_envs().collect();
    assert_eq!(environment.get(OsStr::new("RUSTUP_TOOLCHAIN")), Some(&None));
    assert_eq!(
        environment.get(OsStr::new("RUST_MIN_STACK")),
        Some(&Some(OsStr::new("8388608")))
    );
    assert_eq!(
        environment.get(OsStr::new("NEXTEST_PROFILE")),
        Some(&Some(OsStr::new("local")))
    );
}

fn sources(root: &std::path::Path) {
    for (path, content) in [
        (
            "crates/holycodex-policy/Cargo.toml",
            "[package]\nname='policy'\n",
        ),
        ("crates/holycodex-policy/src/lib.rs", "// policy"),
        ("overlay/holycodex/instructions/root.md", "root"),
        ("overlay/holycodex/skills/test/SKILL.md", "skill"),
        ("crates/holycodex-policy/src/generated/ignored", "generated"),
    ] {
        let path = root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

#[test]
fn owned_sources_use_policy_include_layout_and_manifest_runtime_workspace() {
    let root = tempdir().unwrap();
    let upstream = tempdir().unwrap();
    sources(root.path());
    Plan::prepare(root.path(), upstream.path(), "native/rust")
        .unwrap()
        .install(upstream.path())
        .unwrap();
    for path in [
        "crates/holycodex-policy/src/lib.rs",
        "overlay/holycodex/instructions/root.md",
        "native/rust/skills/src/assets/samples/test/SKILL.md",
    ] {
        assert!(upstream.path().join(path).is_file(), "{path}");
    }
    assert!(
        !upstream
            .path()
            .join("crates/holycodex-policy/src/generated")
            .exists()
    );
    Plan::prepare(root.path(), upstream.path(), "native/rust")
        .unwrap()
        .install(upstream.path())
        .unwrap();
}

#[test]
fn every_destination_is_preflighted_without_overwriting_local_content() {
    let root = tempdir().unwrap();
    let upstream = tempdir().unwrap();
    sources(root.path());
    let conflict = upstream
        .path()
        .join("overlay/holycodex/instructions/root.md");
    fs::create_dir_all(conflict.parent().unwrap()).unwrap();
    fs::write(&conflict, "local").unwrap();
    assert!(Plan::prepare(root.path(), upstream.path(), "codex-rs").is_err());
    assert_eq!(fs::read_to_string(&conflict).unwrap(), "local");
    assert!(!upstream.path().join("crates").exists());
    fs::remove_file(&conflict).unwrap();
    fs::create_dir(&conflict).unwrap();
    assert!(Plan::prepare(root.path(), upstream.path(), "codex-rs").is_err());
}
#[test]
fn fixture_git_rejects_a_different_checkout_revision() {
    let repo = tempdir().unwrap();
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .output()
            .unwrap()
    };
    assert!(git(&["init", "-q"]).status.success());
    assert!(git(&["config", "core.autocrlf", "false"]).status.success());
    assert!(
        git(&["config", "user.email", "test@example.com"])
            .status
            .success()
    );
    assert!(git(&["config", "user.name", "Test"]).status.success());
    fs::write(repo.path().join("base"), "base").unwrap();
    assert!(git(&["add", "base"]).status.success());
    assert!(git(&["commit", "-qm", "base"]).status.success());
    let output = git(&["rev-parse", "HEAD"]);
    assert!(output.status.success());
    let actual = String::from_utf8(output.stdout).unwrap().trim().to_owned();
    assert!(verify_checkout(repo.path(), &actual).is_ok());
    assert!(verify_clean_worktree(repo.path()).is_ok());
    fs::write(repo.path().join("untracked"), "local").unwrap();
    assert!(verify_clean_worktree(repo.path()).is_err());
    assert!(verify_checkout(repo.path(), "a956835d020762cb2b570053af06f643a11c0ecc").is_err());
}

#[test]
fn patch_preflight_rejects_reapplication_without_changing_the_checkout() {
    let root = tempdir().unwrap();
    let repo = tempdir().unwrap();
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .output()
            .unwrap()
    };
    assert!(git(&["init", "-q"]).status.success());
    assert!(git(&["config", "core.autocrlf", "false"]).status.success());
    fs::create_dir(root.path().join("patches")).unwrap();
    fs::write(repo.path().join("file.txt"), "before\n").unwrap();
    assert!(git(&["add", "file.txt"]).status.success());
    assert!(
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "base",
        ])
        .status
        .success()
    );
    fs::write(repo.path().join("file.txt"), "after\n").unwrap();
    let patch = git(&["diff", "--", "file.txt"]);
    assert!(patch.status.success());
    fs::write(root.path().join("patches/0001.patch"), patch.stdout).unwrap();
    fs::write(repo.path().join("file.txt"), "before\n").unwrap();

    sources(root.path());
    let pin = manifest(&crate::root()).unwrap();
    // Ignored destination conflicts must also fail before a valid patch mutates anything.
    fs::write(repo.path().join(".git/info/exclude"), "overlay/\n").unwrap();
    let conflict = repo.path().join("overlay/holycodex/instructions/root.md");
    fs::create_dir_all(conflict.parent().unwrap()).unwrap();
    fs::write(&conflict, "local").unwrap();
    assert!(verify_clean_worktree(repo.path()).is_ok());
    assert!(crate::apply_layer(root.path(), repo.path(), &pin).is_err());
    assert_eq!(
        fs::read_to_string(repo.path().join("file.txt")).unwrap(),
        "before\n"
    );
    assert!(!repo.path().join("crates").exists());
    fs::remove_file(conflict).unwrap();
    // An unrelated untracked file rejects the receiving edge, too.
    fs::write(repo.path().join("local"), "untracked").unwrap();
    assert!(crate::apply_layer(root.path(), repo.path(), &pin).is_err());
    assert_eq!(
        fs::read_to_string(repo.path().join("file.txt")).unwrap(),
        "before\n"
    );
    fs::remove_file(repo.path().join("local")).unwrap();

    crate::apply_layer(root.path(), repo.path(), &pin).unwrap();
    assert_eq!(
        fs::read_to_string(repo.path().join("file.txt")).unwrap(),
        "after\n"
    );
    assert!(apply_patches(root.path(), repo.path()).is_err());
    assert_eq!(
        fs::read_to_string(repo.path().join("file.txt")).unwrap(),
        "after\n"
    );
}

#[test]
fn patch_workspace_manifest_survives_owned_materialization() {
    let root = tempdir().unwrap();
    let repo = tempdir().unwrap();
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .output()
            .unwrap()
    };
    assert!(git(&["init", "-q"]).status.success());
    assert!(git(&["config", "core.autocrlf", "false"]).status.success());
    let workspace = repo.path().join("codex-rs");
    fs::create_dir_all(&workspace).unwrap();
    let manifest_path = workspace.join("Cargo.toml");
    let original_manifest =
        b"[workspace]\nmembers = []\n\n[workspace.dependencies]\nserde = \"1\"\n";
    let patched_manifest = b"[workspace]\nmembers = []\n\n[workspace.dependencies]\nholycodex-policy = { path = '../crates/holycodex-policy' }\nserde = \"1\"\n";
    fs::write(&manifest_path, original_manifest).unwrap();
    assert!(git(&["add", "codex-rs/Cargo.toml"]).status.success());
    assert!(
        git(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-qm",
            "base",
        ])
        .status
        .success()
    );

    fs::write(&manifest_path, patched_manifest).unwrap();
    let patch = git(&["diff", "--", "codex-rs/Cargo.toml"]);
    assert!(patch.status.success());
    fs::create_dir(root.path().join("patches")).unwrap();
    fs::write(
        root.path().join("patches/0001-native-runtime.patch"),
        patch.stdout,
    )
    .unwrap();
    fs::write(&manifest_path, original_manifest).unwrap();
    sources(root.path());

    let pin = manifest(&crate::root()).unwrap();
    crate::apply_layer(root.path(), repo.path(), &pin).unwrap();

    assert_eq!(fs::read(manifest_path).unwrap(), patched_manifest);
    assert_eq!(
        fs::read_to_string(repo.path().join("overlay/holycodex/instructions/root.md")).unwrap(),
        "root"
    );
}
