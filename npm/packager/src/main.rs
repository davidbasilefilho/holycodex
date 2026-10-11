//! Stages native npm packages against the authoritative upstream release pin.
//!
//! Wrapper placeholders exist only for npm linking. Installation must replace
//! them with verified bytes; SHA-256 checks payload consistency, while npm's
//! package integrity remains the authenticity boundary.
#![forbid(unsafe_code)]

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const NOTICES: [&str; 3] = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"];

fn is_holycodex_version(version: &str) -> bool {
    let mut components = version.split('.');
    let Some(major) = components.next() else {
        return false;
    };
    let Some(minor) = components.next() else {
        return false;
    };
    let Some(patch) = components.next() else {
        return false;
    };
    if components.next().is_some() || major != "0" {
        return false;
    }

    fn canonical_number(component: &str) -> Option<u64> {
        if component.is_empty()
            || (component.len() > 1 && component.starts_with('0'))
            || !component.bytes().all(|byte| byte.is_ascii_digit())
        {
            return None;
        }
        component.parse().ok()
    }

    canonical_number(minor).is_some() && canonical_number(patch).is_some()
}

fn npm_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn copy_notices(npm: &Path, destination: &Path) -> Result<()> {
    for name in NOTICES {
        fs::copy(npm.parent().unwrap().join(name), destination.join(name))?;
    }
    Ok(())
}

fn validated_wrapper(npm: &Path) -> Result<Value> {
    let manifest: toml::Value =
        fs::read_to_string(npm.parent().unwrap().join("upstream.toml"))?.parse()?;
    let version = manifest
        .get("holycodex_version")
        .and_then(toml::Value::as_str)
        .ok_or("upstream manifest is missing holycodex_version")?;
    if !is_holycodex_version(version) {
        return Err("upstream.toml holycodex_version must use 0.X.Y stable format".into());
    }
    let wrapper: Value = serde_json::from_slice(&fs::read(npm.join("holycodex/package.json"))?)?;
    if version != env!("CARGO_PKG_VERSION")
        || wrapper["name"] != "holycodex"
        || wrapper["version"] != version
    {
        return Err("Cargo and npm versions must match upstream.toml holycodex_version".into());
    }
    for package in [
        "@turndev/holycodex-native-linux-x64-gnu",
        "@turndev/holycodex-native-darwin-arm64",
        "@turndev/holycodex-native-win32-x64",
    ] {
        if wrapper["optionalDependencies"][package] != version {
            return Err(
                format!("optional dependency {package} must match upstream.toml version").into(),
            );
        }
    }
    Ok(wrapper)
}

fn stage_wrapper(npm: &Path, output: &Path) -> Result<PathBuf> {
    validated_wrapper(npm)?;
    let destination = output.join("holycodex");
    fs::create_dir_all(destination.join("bin"))?;
    for name in ["package.json", "install.cjs", "native-inventory.json"] {
        fs::copy(npm.join("holycodex").join(name), destination.join(name))?;
    }
    // npm needs bin targets present while it creates links/shims. Successful
    // postinstall replaces these empty files with verified native bytes.
    for name in ["holycodex.exe", "codex.exe"] {
        fs::write(destination.join("bin").join(name), [])?;
    }
    copy_notices(npm, &destination)?;
    Ok(destination)
}

fn stage_native(npm: &Path, target: &str, native: &Path, output: &Path) -> Result<PathBuf> {
    let package_name = match target {
        "linux-x64-gnu" => "@turndev/holycodex-native-linux-x64-gnu",
        "darwin-arm64" => "@turndev/holycodex-native-darwin-arm64",
        "win32-x64" => "@turndev/holycodex-native-win32-x64",
        _ => return Err(format!("unsupported target: {target}").into()),
    };
    let extension = if target == "win32-x64" { ".exe" } else { "" };
    let names = [format!("holycodex{extension}"), format!("codex{extension}")];
    let mut payloads = Vec::new();
    for name in &names {
        let source = native.join("bin").join(name);
        if !fs::symlink_metadata(&source)?.file_type().is_file() {
            return Err(format!("payload must be a regular file: {}", source.display()).into());
        }
        payloads.push(fs::read(source)?);
    }
    if payloads[0].is_empty() || payloads[0] != payloads[1] {
        return Err("native payloads must be nonempty and byte-identical".into());
    }
    // Use the exact upstream package layout: the runtime discovers resources
    // through codex-package.json relative to the executable, not through PATH.
    let policy: Value =
        serde_json::from_str(include_str!("../../holycodex/native-inventory.json"))?;
    let pin: toml::Value =
        fs::read_to_string(npm.parent().unwrap().join("upstream.toml"))?.parse()?;
    if pin["commit"].as_str() != policy["upstreamCommit"].as_str() {
        return Err("native inventory does not match upstream pin".into());
    }
    let spec = &policy["targets"][target];
    let layout: Value = serde_json::from_slice(&fs::read(native.join("codex-package.json"))?)?;
    if layout["layoutVersion"] != 1
        || layout["target"] != spec["triple"]
        || layout["version"] != env!("CARGO_PKG_VERSION")
        || layout["variant"] != "codex"
        || layout["resourcesDir"] != "codex-resources"
        || layout["pathDir"] != "codex-path"
        || layout["entrypoint"] != format!("bin/codex{extension}")
    {
        return Err("native package layout does not match the pinned target/runtime".into());
    }
    let mut resources = Vec::new();
    for relative in spec["files"].as_array().ok_or("missing target inventory")? {
        let relative = relative.as_str().ok_or("invalid inventory path")?;
        let source = native.join(relative);
        // Reject symlink ancestors as well as symlink payloads.
        let mut ancestor = source.as_path();
        while ancestor != native {
            if fs::symlink_metadata(ancestor)?.file_type().is_symlink() {
                return Err(
                    format!("native resource must not traverse a symlink: {relative}").into(),
                );
            }
            ancestor = ancestor.parent().ok_or("invalid resource parent")?;
        }
        if !fs::symlink_metadata(&source)?.file_type().is_file() {
            return Err(format!("native resource must be a regular file: {relative}").into());
        }
        let bytes = fs::read(source)?;
        if bytes.is_empty() {
            return Err(format!("empty required native resource: {relative}").into());
        }
        resources.push((relative.to_owned(), bytes));
    }
    let metadata: Value = serde_json::from_slice(&fs::read(
        npm.join(package_name.trim_start_matches("@turndev/"))
            .join("package.json"),
    )?)?;
    let wrapper = validated_wrapper(npm)?;
    if metadata["name"] != package_name
        || metadata["version"] != wrapper["version"]
        || wrapper["optionalDependencies"][package_name] != metadata["version"]
    {
        return Err("platform package metadata does not match the wrapper".into());
    }
    let destination = output.join(package_name.trim_start_matches("@turndev/"));
    fs::create_dir_all(destination.join("bin"))?;
    fs::write(
        destination.join("package.json"),
        serde_json::to_vec_pretty(&metadata)?,
    )?;
    copy_notices(npm, &destination)?;
    for (name, payload) in names.iter().zip(&payloads) {
        let path = destination.join("bin").join(name);
        fs::write(&path, payload)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
        }
    }
    fs::write(
        destination.join("codex-package.json"),
        serde_json::to_vec_pretty(&layout)?,
    )?;
    let mut inventory = serde_json::Map::new();
    for (relative, bytes) in &resources {
        let path = destination.join(relative);
        fs::create_dir_all(path.parent().unwrap())?;
        fs::write(&path, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        }
        inventory.insert(relative.clone(), serde_json::json!({"sha256": format!("{:x}", Sha256::digest(bytes)), "bytes": bytes.len()}));
    }
    let layout_bytes = fs::read(destination.join("codex-package.json"))?;
    inventory.insert("codex-package.json".into(), serde_json::json!({"sha256": format!("{:x}", Sha256::digest(&layout_bytes)), "bytes": layout_bytes.len()}));
    fs::write(
        destination.join("native-inventory.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "format": 1, "upstreamCommit": policy["upstreamCommit"], "target": target, "files": inventory
        }))?,
    )?;
    let manifest = format!(
        "format = 1\npackage = \"{package_name}\"\nversion = \"{}\"\nsha256 = \"{:x}\"\n",
        metadata["version"]
            .as_str()
            .ok_or("package version must be a string")?,
        Sha256::digest(&payloads[0])
    );
    fs::write(destination.join("payload.toml"), manifest)?;
    Ok(destination)
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let destination = match args.as_slice() {
        [kind, output] if kind == "wrapper" => stage_wrapper(&npm_root(), Path::new(output))?,
        [target, native, output] => stage_native(&npm_root(), target, Path::new(native), Path::new(output))?,
        _ => return Err("usage: holycodex-npm-packager TARGET NATIVE_DIRECTORY OUTPUT_DIRECTORY, or wrapper OUTPUT_DIRECTORY".into()),
    };
    println!("{}", destination.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authoritative_version_uses_stable_semver_source() {
        let manifest: toml::Value =
            fs::read_to_string(npm_root().parent().unwrap().join("upstream.toml"))
                .unwrap()
                .parse()
                .unwrap();
        let version = manifest["holycodex_version"].as_str().unwrap();
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
        assert!(is_holycodex_version(version));
        assert!(is_holycodex_version("0.17.0"));
        assert!(is_holycodex_version("0.17.1"));
        assert!(!is_holycodex_version("0.17.0-1"));
        assert!(!is_holycodex_version("0.17.0-dev.123"));
        assert!(!is_holycodex_version("0.17.0-alpha"));
        assert!(!is_holycodex_version("0.17.0-01"));
        assert!(!is_holycodex_version("0.017.0"));
        assert!(!is_holycodex_version("1.17.0"));
    }
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            loop {
                let id = NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir()
                    .join(format!("holycodex-packager-{}-{id}", std::process::id()));
                match fs::create_dir(&path) {
                    Ok(()) => return Self(path),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("failed to create test fixture: {error}"),
                }
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn fixture_directories_are_unique_when_created_concurrently() {
        let fixtures: Vec<_> = (0..32).map(|_| std::thread::spawn(Fixture::new)).collect();
        let paths: std::collections::HashSet<_> = fixtures
            .into_iter()
            .map(|fixture| fixture.join().unwrap().0.clone())
            .collect();
        assert_eq!(paths.len(), 32);
    }

    #[test]
    fn stages_payload_digest_and_notices_then_rejects_alias_mismatch() {
        let fixture = Fixture::new();
        let native = fixture.0.join("native");
        let output = fixture.0.join("packages");
        fs::create_dir_all(native.join("bin")).unwrap();
        native_resources_fixture(&native, "linux-x64-gnu");
        for name in ["holycodex", "codex"] {
            fs::write(native.join("bin").join(name), b"abc").unwrap();
        }
        let package = stage_native(&npm_root(), "linux-x64-gnu", &native, &output).unwrap();
        let manifest: toml::Value = fs::read_to_string(package.join("payload.toml"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            manifest["sha256"].as_str().unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            manifest["package"].as_str(),
            Some("@turndev/holycodex-native-linux-x64-gnu")
        );
        assert_eq!(manifest["version"].as_str(), Some("0.17.0"));
        assert_eq!(manifest["format"].as_integer(), Some(1));
        assert_eq!(
            fs::read(package.join("bin/holycodex")).unwrap(),
            fs::read(package.join("bin/codex")).unwrap()
        );
        for name in NOTICES {
            assert_eq!(
                fs::read(package.join(name)).unwrap(),
                fs::read(npm_root().parent().unwrap().join(name)).unwrap()
            );
        }
        fs::write(native.join("bin/codex"), b"different").unwrap();
        let rejected = fixture.0.join("rejected");
        assert!(stage_native(&npm_root(), "linux-x64-gnu", &native, &rejected).is_err());
        assert!(!rejected.exists());
    }

    fn native_resources_fixture(native: &Path, target: &str) {
        let policy: Value =
            serde_json::from_str(include_str!("../../holycodex/native-inventory.json")).unwrap();
        let spec = &policy["targets"][target];
        for file in spec["files"].as_array().unwrap() {
            let path = native.join(file.as_str().unwrap());
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"resource fixture, not an executable").unwrap();
        }
        fs::write(native.join("codex-package.json"), serde_json::to_vec(&json!({
            "layoutVersion": 1, "target": spec["triple"], "version": "0.17.0", "variant": "codex",
            "entrypoint": if target == "win32-x64" { "bin/codex.exe" } else { "bin/codex" },
            "resourcesDir": "codex-resources", "pathDir": "codex-path"
        })).unwrap()).unwrap();
    }

    #[test]
    fn every_target_requires_all_helpers_before_staging() {
        for target in ["linux-x64-gnu", "darwin-arm64", "win32-x64"] {
            let fixture = Fixture::new();
            let native = fixture.0.join("native");
            fs::create_dir_all(native.join("bin")).unwrap();
            native_resources_fixture(&native, target);
            let extension = if target == "win32-x64" { ".exe" } else { "" };
            for alias in ["codex", "holycodex"] {
                fs::write(native.join(format!("bin/{alias}{extension}")), b"abc").unwrap();
            }
            let output = fixture.0.join("out");
            let package = stage_native(&npm_root(), target, &native, &output).unwrap();
            let inventory: Value =
                serde_json::from_slice(&fs::read(package.join("native-inventory.json")).unwrap())
                    .unwrap();
            assert_eq!(inventory["target"], target);
            for relative in inventory["files"]
                .as_object()
                .unwrap()
                .keys()
                .filter(|p| p.as_str() != "codex-package.json")
            {
                let source = native.join(relative);
                let bytes = fs::read(&source).unwrap();
                fs::remove_file(&source).unwrap();
                let rejected = fixture.0.join("rejected");
                assert!(stage_native(&npm_root(), target, &native, &rejected).is_err());
                assert!(!rejected.exists());
                fs::write(source, bytes).unwrap();
            }
        }
    }

    #[test]
    fn platform_package_metadata_declares_toml_payload_proof() {
        for package in [
            "@turndev/holycodex-native-linux-x64-gnu",
            "@turndev/holycodex-native-darwin-arm64",
            "@turndev/holycodex-native-win32-x64",
        ] {
            let metadata: Value = serde_json::from_slice(
                &fs::read(
                    npm_root()
                        .join(package.trim_start_matches("@turndev/"))
                        .join("package.json"),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(
                metadata["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|path| path == "payload.toml")
            );
            assert!(
                !metadata["files"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|path| path == "payload.json")
            );
        }
    }

    #[test]
    fn wrapper_has_empty_link_targets_and_exact_root_notices() {
        let fixture = Fixture::new();
        let wrapper = stage_wrapper(&npm_root(), &fixture.0).unwrap();
        for name in ["holycodex.exe", "codex.exe"] {
            assert!(fs::read(wrapper.join("bin").join(name)).unwrap().is_empty());
        }
        for name in NOTICES {
            assert_eq!(
                fs::read(wrapper.join(name)).unwrap(),
                fs::read(npm_root().parent().unwrap().join(name)).unwrap()
            );
        }
    }

    #[test]
    fn rejects_npm_version_drift_from_authoritative_manifest() {
        let fixture = Fixture::new();
        let npm = fixture.0.join("npm");
        fs::create_dir_all(npm.join("holycodex")).unwrap();
        fs::copy(
            npm_root().parent().unwrap().join("upstream.toml"),
            fixture.0.join("upstream.toml"),
        )
        .unwrap();
        let mut wrapper: Value =
            serde_json::from_slice(&fs::read(npm_root().join("holycodex/package.json")).unwrap())
                .unwrap();
        wrapper["version"] = json!("0.0.0");
        fs::write(
            npm.join("holycodex/package.json"),
            serde_json::to_vec(&wrapper).unwrap(),
        )
        .unwrap();
        let output = fixture.0.join("output");
        assert!(stage_wrapper(&npm, &output).is_err());
        assert!(!output.exists());
    }
}
