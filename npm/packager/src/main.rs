//! Stages native npm packages against the authoritative upstream release pin.
//!
//! Wrapper placeholders exist only for npm linking. Installation must replace
//! them with verified bytes; SHA-256 checks payload consistency, while npm's
//! package integrity remains the authenticity boundary.
#![forbid(unsafe_code)]

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const NOTICES: [&str; 3] = ["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"];

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
    let wrapper: Value = serde_json::from_slice(&fs::read(npm.join("holycodex/package.json"))?)?;
    if version != env!("CARGO_PKG_VERSION")
        || wrapper["name"] != "holycodex"
        || wrapper["version"] != version
    {
        return Err("Cargo and npm versions must match upstream.toml holycodex_version".into());
    }
    for package in [
        "holycodex-native-linux-x64-gnu",
        "holycodex-native-darwin-arm64",
        "holycodex-native-win32-x64",
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
    for name in ["package.json", "install.cjs"] {
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
        "linux-x64-gnu" => "holycodex-native-linux-x64-gnu",
        "darwin-arm64" => "holycodex-native-darwin-arm64",
        "win32-x64" => "holycodex-native-win32-x64",
        _ => return Err(format!("unsupported target: {target}").into()),
    };
    let extension = if target == "win32-x64" { ".exe" } else { "" };
    let names = [format!("holycodex{extension}"), format!("codex{extension}")];
    let mut payloads = Vec::new();
    for name in &names {
        let source = native.join(name);
        if !fs::symlink_metadata(&source)?.file_type().is_file() {
            return Err(format!("payload must be a regular file: {}", source.display()).into());
        }
        payloads.push(fs::read(source)?);
    }
    if payloads[0].is_empty() || payloads[0] != payloads[1] {
        return Err("native payloads must be nonempty and byte-identical".into());
    }
    let metadata: Value =
        serde_json::from_slice(&fs::read(npm.join(package_name).join("package.json"))?)?;
    let wrapper = validated_wrapper(npm)?;
    if metadata["name"] != package_name
        || metadata["version"] != wrapper["version"]
        || wrapper["optionalDependencies"][package_name] != metadata["version"]
    {
        return Err("platform package metadata does not match the wrapper".into());
    }
    let destination = output.join(package_name);
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
    let manifest = json!({
        "format": 1,
        "package": package_name,
        "version": metadata["version"],
        "sha256": format!("{:x}", Sha256::digest(&payloads[0])),
    });
    fs::write(
        destination.join("payload.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
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
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir()
                .join(format!("holycodex-packager-{}-{nonce}", std::process::id()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn stages_payload_digest_and_notices_then_rejects_alias_mismatch() {
        let fixture = Fixture::new();
        let native = fixture.0.join("native");
        let output = fixture.0.join("packages");
        fs::create_dir(&native).unwrap();
        for name in ["holycodex", "codex"] {
            fs::write(native.join(name), b"abc").unwrap();
        }
        let package = stage_native(&npm_root(), "linux-x64-gnu", &native, &output).unwrap();
        let manifest: Value =
            serde_json::from_slice(&fs::read(package.join("payload.json")).unwrap()).unwrap();
        assert_eq!(
            manifest["sha256"],
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
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
        fs::write(native.join("codex"), b"different").unwrap();
        let rejected = fixture.0.join("rejected");
        assert!(stage_native(&npm_root(), "linux-x64-gnu", &native, &rejected).is_err());
        assert!(!rejected.exists());
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
