//! TOON Specification Conformance Tests
//!
//! Runs tests from the official spec/tests/fixtures directory.
//! Set TOON_CONFORMANCE=1 to run these tests.

#![cfg(feature = "json")]
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const FIXTURE_METADATA: &str = include_str!("../../../tests/fixtures/toon/metadata.toml");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureMetadata {
    format: String,
    spec_version: String,
    spec_status: String,
    spec_commit: String,
    spec_sha256: String,
    fixture_source: String,
    fixture_commit: String,
    fixture_license: String,
    fixture_file_count: usize,
    encode_case_count: usize,
    decode_case_count: usize,
    #[allow(dead_code)]
    codec_source: String,
    #[allow(dead_code)]
    codec_revision: String,
    #[allow(dead_code)]
    codec_crate_version: String,
    #[allow(dead_code)]
    codec_rust_version: String,
    #[allow(dead_code)]
    codec_license: String,
    fixtures: Vec<PinnedFixture>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PinnedFixture {
    group: String,
    file: String,
    sha256: String,
}

#[derive(Debug, Deserialize)]
struct FixtureFile {
    #[allow(dead_code)]
    version: String,
    #[allow(dead_code)]
    category: String,
    #[allow(dead_code)]
    description: String,
    tests: Vec<TestCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestCase {
    name: String,
    input: serde_json::Value,
    expected: serde_json::Value,
    #[serde(default)]
    should_error: bool,
    #[serde(default)]
    options: TestOptions,
    #[allow(dead_code)]
    #[serde(default)]
    spec_section: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    note: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    min_spec_version: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TestOptions {
    #[serde(default)]
    delimiter: Option<String>,
    #[allow(dead_code)]
    #[serde(default, alias = "indentSize")]
    indent: Option<usize>,
    #[serde(default)]
    strict: Option<bool>,
    #[serde(default)]
    key_folding: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    flatten_depth: Option<usize>,
    #[serde(default)]
    expand_paths: Option<String>,
}

fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/toon")
}

fn fixture_files(root: &Path, group: &str) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let directory = root.join(group);
    let mut paths = fs::read_dir(&directory)?
        .map(|entry| {
            let path = entry?.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unexpected non-JSON fixture entry {}", path.display()),
                ));
            }
            Ok(path)
        })
        .collect::<Result<Vec<_>, std::io::Error>>()?;
    paths.sort();
    Ok(paths)
}

fn verify_fixture_group(
    root: &Path,
    group: &str,
    fixtures: &[PinnedFixture],
) -> Result<Vec<PathBuf>, Box<dyn std::error::Error>> {
    let mut expected = BTreeMap::new();
    for fixture in fixtures.iter().filter(|fixture| fixture.group == group) {
        if expected
            .insert(fixture.file.as_str(), fixture.sha256.as_str())
            .is_some()
        {
            return Err(format!("duplicate pinned fixture {group}/{}", fixture.file).into());
        }
    }

    let paths = fixture_files(root, group)?;
    let actual_names = paths
        .iter()
        .map(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("non-UTF-8 fixture filename: {}", path.display()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let expected_names = expected.keys().copied().collect::<Vec<_>>();
    if actual_names != expected_names {
        return Err(format!(
            "{group} fixture inventory differs from pinned names: expected {expected_names:?}, got {actual_names:?}"
        )
        .into());
    }

    for path in &paths {
        let name = path.file_name().and_then(|name| name.to_str()).unwrap();
        let bytes = fs::read(path)?;
        let digest = Sha256::digest(bytes);
        let actual_hash = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if expected.get(name).copied() != Some(actual_hash.as_str()) {
            return Err(format!("fixture byte hash mismatch for {group}/{name}").into());
        }
    }
    Ok(paths)
}

fn pinned_fixture_sets() -> Result<(Vec<PathBuf>, Vec<PathBuf>), Box<dyn std::error::Error>> {
    let metadata: FixtureMetadata = toml::from_str(FIXTURE_METADATA)?;
    assert_eq!(metadata.format, "TOON");
    assert_eq!(metadata.spec_version, "4.1");
    assert_eq!(metadata.spec_status, "Working Draft");
    assert_eq!(
        metadata.spec_commit,
        "e7a2b337b7c06eb07e2d18bbf42a58e04dc285a5"
    );
    assert_eq!(
        metadata.spec_sha256,
        "6d83c75bff7aef6d9ad29b6278e4fa98750ebfbd07d4cb402af4dbe9188e8526"
    );
    assert_eq!(
        metadata.fixture_commit,
        "e7a2b337b7c06eb07e2d18bbf42a58e04dc285a5"
    );
    assert_eq!(metadata.fixture_license, "MIT");
    assert!(
        metadata
            .fixture_source
            .ends_with(&format!("{}/tests/fixtures", metadata.fixture_commit))
    );
    assert_eq!(metadata.fixtures.len(), metadata.fixture_file_count);

    let root = fixtures_root();
    let encode = verify_fixture_group(&root, "encode", &metadata.fixtures)?;
    let decode = verify_fixture_group(&root, "decode", &metadata.fixtures)?;
    assert_eq!(encode.len() + decode.len(), metadata.fixture_file_count);
    Ok((encode, decode))
}

fn make_encode_options(opts: &TestOptions) -> holycodex_toon::Options {
    let mut o = holycodex_toon::Options::default();
    if let Some(ref d) = opts.delimiter {
        o.delimiter = match d.as_str() {
            "\t" => holycodex_toon::Delimiter::Tab,
            "|" => holycodex_toon::Delimiter::Pipe,
            _ => holycodex_toon::Delimiter::Comma,
        };
    }
    if let Some(ref kf) = opts.key_folding {
        o.key_folding = match kf.as_str() {
            "safe" => holycodex_toon::KeyFolding::Safe,
            _ => holycodex_toon::KeyFolding::Off,
        };
    }
    if let Some(fd) = opts.flatten_depth {
        o.flatten_depth = Some(fd);
    }
    if let Some(indent) = opts.indent {
        o.indent = indent;
    }
    o
}

fn make_decode_options(opts: &TestOptions) -> holycodex_toon::Options {
    let mut o = holycodex_toon::Options::default();
    if let Some(strict) = opts.strict {
        o.strict = strict;
    }
    if let Some(indent) = opts.indent {
        o.indent = indent;
    }
    if let Some(ref ep) = opts.expand_paths {
        o.expand_paths = match ep.as_str() {
            "safe" => holycodex_toon::ExpandPaths::Safe,
            _ => holycodex_toon::ExpandPaths::Off,
        };
    }
    o
}

#[test]
fn decode_fixtures() -> Result<(), Box<dyn std::error::Error>> {
    let (_, fixture_paths) = pinned_fixture_sets()?;

    let mut total = 0;
    let mut passed = 0;
    let mut failed_tests: Vec<String> = Vec::new();

    for path in fixture_paths {
        let content = fs::read_to_string(&path)?;
        let fixture: FixtureFile = serde_json::from_str(&content)?;

        eprintln!(
            "  Testing decode/{}",
            path.file_name().unwrap().to_string_lossy()
        );

        for test in &fixture.tests {
            total += 1;

            let toon_input = match &test.input {
                serde_json::Value::String(s) => s.clone(),
                _ => {
                    eprintln!("    FAIL {}: decode input must be string", test.name);
                    failed_tests.push(format!(
                        "decode/{}: input must be string",
                        path.file_name().unwrap().to_string_lossy()
                    ));
                    continue;
                }
            };

            let opts = make_decode_options(&test.options);
            let result: Result<serde_json::Value, _> =
                holycodex_toon::decode_from_str(&toon_input, &opts);

            if test.should_error {
                if let Ok(got) = result {
                    eprintln!("    FAIL {}: expected error but got {:?}", test.name, got);
                    failed_tests.push(format!(
                        "decode/{}: {}",
                        path.file_name().unwrap().to_string_lossy(),
                        test.name
                    ));
                } else {
                    passed += 1;
                }
            } else {
                match result {
                    Ok(got) => {
                        if got == test.expected {
                            passed += 1;
                        } else {
                            eprintln!("    FAIL {}", test.name);
                            eprintln!("      input: {:?}", toon_input);
                            eprintln!("      expected: {:?}", test.expected);
                            eprintln!("      got: {:?}", got);
                            failed_tests.push(format!(
                                "decode/{}: {}",
                                path.file_name().unwrap().to_string_lossy(),
                                test.name
                            ));
                        }
                    }
                    Err(e) => {
                        eprintln!("    FAIL {}: unexpected error: {}", test.name, e);
                        failed_tests.push(format!(
                            "decode/{}: {}",
                            path.file_name().unwrap().to_string_lossy(),
                            test.name
                        ));
                    }
                }
            }
        }
    }

    let metadata: FixtureMetadata = toml::from_str(FIXTURE_METADATA)?;
    assert_eq!(total, metadata.decode_case_count);
    assert_eq!(passed, total, "decode corpus had unpassed or skipped cases");
    eprintln!("✓ decode: {passed}/{total} passed");
    if !failed_tests.is_empty() {
        eprintln!("Failed tests:");
        for t in &failed_tests {
            eprintln!("  - {}", t);
        }
    }
    assert!(failed_tests.is_empty(), "Some decode tests failed");
    Ok(())
}

#[test]
fn encode_fixtures() -> Result<(), Box<dyn std::error::Error>> {
    let (fixture_paths, _) = pinned_fixture_sets()?;

    let mut total = 0;
    let mut passed = 0;
    let mut failed_tests: Vec<String> = Vec::new();

    for path in fixture_paths {
        let content = fs::read_to_string(&path)?;
        let fixture: FixtureFile = serde_json::from_str(&content)?;

        eprintln!(
            "  Testing encode/{}",
            path.file_name().unwrap().to_string_lossy()
        );

        for test in &fixture.tests {
            total += 1;

            let expected_toon = match &test.expected {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Null if test.should_error => String::new(),
                _ => {
                    eprintln!("    FAIL {}: encode expected must be string", test.name);
                    failed_tests.push(format!(
                        "encode/{}: expected output must be string",
                        path.file_name().unwrap().to_string_lossy()
                    ));
                    continue;
                }
            };

            let opts = make_encode_options(&test.options);
            let result = holycodex_toon::encode_to_string(&test.input, &opts);

            if test.should_error {
                if let Ok(got) = result {
                    eprintln!("    FAIL {}: expected error but got {:?}", test.name, got);
                    failed_tests.push(format!(
                        "encode/{}: {}",
                        path.file_name().unwrap().to_string_lossy(),
                        test.name
                    ));
                } else {
                    passed += 1;
                }
            } else {
                match result {
                    Ok(got) => {
                        // Normalize newlines for comparison
                        let norm = |s: &str| s.replace("\r\n", "\n");
                        if norm(&got) == norm(&expected_toon) {
                            passed += 1;
                        } else {
                            eprintln!("    FAIL {}", test.name);
                            eprintln!("      input: {:?}", test.input);
                            eprintln!("      expected: {:?}", expected_toon);
                            eprintln!("      got: {:?}", got);
                            failed_tests.push(format!(
                                "encode/{}: {}",
                                path.file_name().unwrap().to_string_lossy(),
                                test.name
                            ));
                        }
                    }
                    Err(e) => {
                        eprintln!("    FAIL {}: unexpected error: {}", test.name, e);
                        failed_tests.push(format!(
                            "encode/{}: {}",
                            path.file_name().unwrap().to_string_lossy(),
                            test.name
                        ));
                    }
                }
            }
        }
    }

    let metadata: FixtureMetadata = toml::from_str(FIXTURE_METADATA)?;
    assert_eq!(total, metadata.encode_case_count);
    assert_eq!(passed, total, "encode corpus had unpassed or skipped cases");
    eprintln!("✓ encode: {passed}/{total} passed");
    if !failed_tests.is_empty() {
        eprintln!("Failed tests:");
        for t in &failed_tests {
            eprintln!("  - {}", t);
        }
    }
    assert!(failed_tests.is_empty(), "Some encode tests failed");
    Ok(())
}

#[cfg(test)]
mod fixture_pin_tests {
    use super::{PinnedFixture, verify_fixture_group};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT_TEMP: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn fixture_pin_rejects_same_count_content_substitution_and_rename() {
        let root = std::env::temp_dir().join(format!(
            "holycodex-toon-fixture-pin-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let group = root.join("encode");
        fs::create_dir_all(&group).unwrap();
        let original = b"{\"tests\":[{\"name\":\"pinned\"}]}\n";
        let path = group.join("case.json");
        fs::write(&path, original).unwrap();
        let hash = Sha256::digest(original)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let pinned = [PinnedFixture {
            group: "encode".to_owned(),
            file: "case.json".to_owned(),
            sha256: hash,
        }];

        assert!(verify_fixture_group(&root, "encode", &pinned).is_ok());

        let mut changed_same_length = original.to_vec();
        let last_content_byte = changed_same_length.len() - 2;
        changed_same_length[last_content_byte] ^= 1;
        fs::write(&path, changed_same_length).unwrap();
        let error = verify_fixture_group(&root, "encode", &pinned).unwrap_err();
        assert!(error.to_string().contains("byte hash mismatch"));

        fs::remove_file(&path).unwrap();
        fs::write(group.join("renamed.json"), original).unwrap();
        let error = verify_fixture_group(&root, "encode", &pinned).unwrap_err();
        assert!(error.to_string().contains("inventory differs"));

        fs::remove_dir_all(root).unwrap();
    }
}
