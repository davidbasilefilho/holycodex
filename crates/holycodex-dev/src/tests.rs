use std::fs;
use std::process::Command;

use tempfile::tempdir;

use crate::materialization::{Plan, validate_relative};
use crate::{apply_patches, manifest, valid_revision, verify_checkout, verify_clean_worktree};

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
