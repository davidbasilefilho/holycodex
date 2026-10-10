import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("inventory", HERE / "inventory.py")
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class SelectionTests(unittest.TestCase):
    def setUp(self):
        self.package = {"name": "codex-cli", "version": "0.17.0", "id": "root", "license": "Apache-2.0"}
        self.metadata = {"packages": [self.package]}

    def test_deduplicates_and_preserves_host_target_feature_sets(self):
        result = inventory.select_packages(self.metadata, "codex-cli v0.17.0 (/repo)|Apache-2.0|a,b\ncodex-cli v0.17.0 (/repo)|Apache-2.0|c (*)\n", "codex-cli")
        self.assertEqual(result, [{"package": self.package, "feature_sets": {("a", "b"), ("c",)}}])

    def test_ambiguous_source_is_not_silently_assigned(self):
        self.metadata["packages"].append({**self.package, "id": "other-source"})
        with self.assertRaisesRegex(inventory.InventoryError, "ambiguous"):
            inventory.select_packages(self.metadata, "codex-cli v0.17.0|Apache-2.0|", "codex-cli")

    def test_unknown_tree_format_is_not_ignored(self):
        with self.assertRaisesRegex(inventory.InventoryError, "Unrecognized"):
            inventory.select_packages(self.metadata, "unexpected output", "codex-cli")

    def test_conflicting_license_fails(self):
        with self.assertRaisesRegex(inventory.InventoryError, "Conflicting"):
            inventory.select_packages(self.metadata, "codex-cli v0.17.0|MIT|", "codex-cli")


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.package_root = self.root / "crate"
        self.package_root.mkdir()
        self.output = self.root / "output"
        (self.output / "texts").mkdir(parents=True)
        (self.package_root / "Cargo.toml").write_text('[package]\nname="example"\nversion="1.0.0"\nlicense="MIT"\n')
        (self.package_root / "LICENSE-MIT").write_text("MIT license fixture\n")
        (self.package_root / "nested").mkdir()
        (self.package_root / "nested" / "NOTICE.txt").write_text("Nested attribution fixture\n")
        self.package = {"name": "example", "version": "1.0.0", "id": "registry#example@1.0.0", "source": "registry+https://example.test/index", "manifest_path": str(self.package_root / "Cargo.toml"), "license": "MIT", "license_file": None}
        self.lock = [{"name": "example", "version": "1.0.0", "source": self.package["source"], "checksum": "a" * 64}]

    def record(self):
        return inventory.package_record({"package": self.package, "feature_sets": {()}}, self.lock, self.root, self.output)

    def test_records_exact_checksum_and_nested_notice_bytes(self):
        record = self.record()
        self.assertEqual(record["source"], {"kind": "registry", "id": self.package["source"], "cargo_lock_checksum": "a" * 64})
        self.assertEqual([item["path"] for item in record["license_notice_candidates"]], ["LICENSE-MIT", "nested/NOTICE.txt"])
        for item in record["license_notice_candidates"]:
            self.assertEqual((self.output / item["text_file"]).read_bytes(), (self.package_root / item["path"]).read_bytes())

    def test_missing_and_conflicting_checksums_fail(self):
        self.lock[0].pop("checksum")
        with self.assertRaisesRegex(inventory.InventoryError, "Missing registry checksum"):
            self.record()
        self.lock[0]["checksum"] = "a" * 64
        (self.package_root / ".cargo-checksum.json").write_text(json.dumps({"package": "b" * 64}))
        with self.assertRaisesRegex(inventory.InventoryError, "Conflicting registry checksum"):
            self.record()

    def test_missing_license_metadata_fails_even_when_license_exists(self):
        self.package["license"] = None
        with self.assertRaisesRegex(inventory.InventoryError, "Missing license"):
            self.record()

    def test_conflicting_manifest_license_fails(self):
        self.package["license"] = "Apache-2.0"
        with self.assertRaisesRegex(inventory.InventoryError, "Conflicting manifest"):
            self.record()

    def test_absent_license_text_fails_even_when_notice_exists(self):
        (self.package_root / "LICENSE-MIT").unlink()
        with self.assertRaisesRegex(inventory.InventoryError, "No license text"):
            self.record()

    def test_license_directory_text_counts_as_evidence(self):
        (self.package_root / "LICENSE-MIT").unlink()
        (self.package_root / "LICENSES").mkdir()
        (self.package_root / "LICENSES" / "MIT.txt").write_text("MIT fixture text\n")
        record = self.record()
        self.assertIn("LICENSES/MIT.txt", [item["path"] for item in record["license_notice_candidates"]])

    def test_declared_license_file_is_required(self):
        self.package["license_file"] = "missing.txt"
        with self.assertRaisesRegex(inventory.InventoryError, "Cannot read required"):
            self.record()

    def test_escaping_license_path_fails(self):
        self.package["license_file"] = "../secret.txt"
        (self.root / "secret.txt").write_text("outside source")
        with self.assertRaisesRegex(inventory.InventoryError, "escapes"):
            self.record()

    @unittest.skipUnless(hasattr(os, "symlink"), "Symlinks unavailable")
    def test_internal_license_symlink_preserves_target_and_external_fails(self):
        link = self.package_root / "LICENSE-ALIAS"
        link.symlink_to("LICENSE-MIT")
        record = self.record()
        self.assertEqual(record["license_notice_candidates"][0]["symlink_target"], "LICENSE-MIT")
        link.unlink()
        (self.root / "outside.txt").write_text("outside")
        link.symlink_to("../outside.txt")
        with self.assertRaisesRegex(inventory.InventoryError, "escapes"):
            self.record()

    def test_lock_identity_conflict_fails(self):
        self.lock.append(copy.deepcopy(self.lock[0]))
        with self.assertRaisesRegex(inventory.InventoryError, "conflicting Cargo.lock"):
            self.record()


@unittest.skipUnless(shutil.which("cargo") and shutil.which("git"), "Cargo and Git required for real offline resolver fixture")
class CargoIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        (self.root / "src").mkdir()
        (self.root / "src" / "main.rs").write_text("fn main() {}\n")
        (self.root / "LICENSE").write_text("Apache-2.0 fixture text\n")
        (self.root / "NOTICE").write_text("Fixture attribution\n")
        (self.root / "Cargo.toml").write_text('''[package]
name = "codex-cli"
version = "0.17.0"
edition = "2021"
license = "Apache-2.0"
[workspace]
resolver = "2"
members = ["common", "linux-only", "windows-only", "build-helper", "dev-only", "optional-on", "optional-off", "dev-feature-only"]
[dependencies]
common = { path = "common" }
optional-on = { path = "optional-on", optional = true }
optional-off = { path = "optional-off", optional = true }
[features]
default = ["dep:optional-on"]
[target.'cfg(target_os = "linux")'.dependencies]
linux-only = { path = "linux-only" }
[target.'cfg(target_os = "windows")'.dependencies]
windows-only = { path = "windows-only" }
[build-dependencies]
build-helper = { path = "build-helper" }
[dev-dependencies]
dev-only = { path = "dev-only" }
common = { path = "common", features = ["dev-extra"] }
''')
        for name in ["common", "linux-only", "windows-only", "build-helper", "dev-only", "optional-on", "optional-off", "dev-feature-only"]:
            crate = self.root / name
            (crate / "src").mkdir(parents=True)
            (crate / "src" / "lib.rs").write_text("// fixture\n")
            (crate / "Cargo.toml").write_text(f'[package]\nname="{name}"\nversion="1.0.0"\nedition="2021"\nlicense="Apache-2.0"\n')
        with (self.root / "common" / "Cargo.toml").open("a") as manifest:
            manifest.write('\n[dependencies]\ndev-feature-only={path="../dev-feature-only", optional=true}\n[features]\ndev-extra=["dep:dev-feature-only"]\n')
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"], cwd=self.root, check=True)
        subprocess.run(["cargo", "generate-lockfile", "--offline"], cwd=self.root, check=True, capture_output=True)

    def invoke(self, target, directory):
        return subprocess.run([os.sys.executable, str(HERE / "inventory.py"), "--source-root", str(self.root), "--manifest-path", str(self.root / "Cargo.toml"), "--target", target, "--offline", "--output", str(self.base / directory)], capture_output=True, text=True)

    def test_real_locked_target_closures_exclude_dev_and_disabled_optional(self):
        for target, specific in [("x86_64-unknown-linux-gnu", "linux-only"), ("x86_64-pc-windows-msvc", "windows-only")]:
            with self.subTest(target=target):
                result = self.invoke(target, target)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                report = json.loads((self.base / target / "inventory.json").read_text())
                self.assertEqual({package["name"] for package in report["packages"]}, {"codex-cli", "common", "build-helper", "optional-on", specific})
                self.assertEqual(report["status"], "source_inventory_collected")
                self.assertEqual(report["legal_completeness"], "unverified")
        first = self.invoke("x86_64-unknown-linux-gnu", "repeat")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual((self.base / "repeat" / "inventory.json").read_bytes(), (self.base / "x86_64-unknown-linux-gnu" / "inventory.json").read_bytes())
        refused = self.invoke("x86_64-unknown-linux-gnu", "repeat")
        self.assertEqual(refused.returncode, 1)
        self.assertIn("already exists", refused.stderr)

    def test_source_fingerprint_tracks_changes_and_deletions(self):
        before = inventory.source_identity(self.root)
        path = self.root / "src" / "main.rs"
        path.write_text("fn main() { println!(\"changed\"); }\n")
        changed = inventory.source_identity(self.root)
        self.assertNotEqual(before["source_files_sha256"], changed["source_files_sha256"])
        self.assertTrue(changed["git_worktree_modified"])
        path.unlink()
        deleted = inventory.source_identity(self.root)
        self.assertNotEqual(changed["source_files_sha256"], deleted["source_files_sha256"])

    def test_missing_metadata_writes_incomplete_report_and_fails(self):
        path = self.root / "common" / "Cargo.toml"
        path.write_text(path.read_text().replace('license="Apache-2.0"', ''))
        result = self.invoke("x86_64-unknown-linux-gnu", "incomplete")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        report = json.loads((self.base / "incomplete" / "inventory.json").read_text())
        self.assertEqual(report["status"], "incomplete")
        self.assertEqual(report["errors"][0]["name"], "common")
        self.assertIn("Missing license", report["errors"][0]["error"])


if __name__ == "__main__":
    unittest.main()
