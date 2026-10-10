#!/usr/bin/env python3
"""Collect review evidence for a locked, target-specific Cargo production tree."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import tomllib


class InventoryError(Exception):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def run(command, cwd):
    try:
        result = subprocess.run(command, cwd=cwd, capture_output=True, check=False)
    except OSError as exc:
        raise InventoryError(f"Cannot run {command[0]}: {exc}") from exc
    if result.returncode:
        raise InventoryError(
            f"Command failed ({result.returncode}): {' '.join(command)}\n"
            + result.stderr.decode("utf-8", errors="replace")
        )
    return result.stdout


def read_file(path, boundary):
    """Never follow a license/source link outside its recorded source root."""
    if not path.resolve().is_relative_to(boundary.resolve()):
        raise InventoryError(f"Source file escapes its root: {path}")
    try:
        return path.read_bytes()
    except OSError as exc:
        raise InventoryError(f"Cannot read required source file {path}: {exc}") from exc


def source_identity(root):
    actual_root = Path(run(["git", "rev-parse", "--show-toplevel"], root).decode().strip())
    if actual_root.resolve() != root:
        raise InventoryError("--source-root must be the materialized repository's Git root")
    revision = run(["git", "rev-parse", "HEAD"], root).decode().strip()
    paths = run(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], root)
    records = []
    for name in sorted(set(paths.decode().split("\0")) - {""}):
        path = root / name
        # Deletions are part of the fingerprint; ignored build outputs are not.
        if path.is_symlink():
            digest = "symlink:" + sha256(os.readlink(path).encode())
        else:
            digest = sha256(read_file(path, root)) if path.exists() else None
        records.append([name, digest])
    return {
        "git_revision": revision,
        "git_worktree_modified": bool(run(["git", "status", "--porcelain", "--untracked-files=normal"], root)),
        "source_files_sha256": sha256(json.dumps(records, separators=(",", ":")).encode()),
        "source_file_count": len(records),
        "fingerprint_scope": "Git tracked files and non-ignored untracked files, including deletions",
    }


def select_packages(metadata, tree, root_package):
    """Cargo owns cfg/feature resolution; never treat every lock entry as runtime."""
    by_key = {}
    for package in metadata["packages"]:
        by_key.setdefault((package["name"], package["version"]), []).append(package)
    selected = {}
    for line in tree.splitlines():
        if not line.strip() or line.strip() in {"[build-dependencies]", "[proc-macro]"}:
            continue
        line = line.removesuffix(" (*)")
        fields = line.split("|")
        match = re.fullmatch(r"([A-Za-z0-9_-]+) v([^ ]+)(?: \(.+\))?", fields[0])
        if len(fields) != 3 or not match:
            raise InventoryError(f"Unrecognized cargo tree output: {line!r}")
        key = match.groups()
        candidates = by_key.get(key, [])
        if len(candidates) != 1:
            raise InventoryError(f"Missing or ambiguous metadata for tree package {key}")
        package = candidates[0]
        if fields[1] != (package.get("license") or ""):
            raise InventoryError(f"Conflicting tree/metadata license for {key}")
        entry = selected.setdefault(package["id"], {"package": package, "feature_sets": set()})
        entry["feature_sets"].add(tuple(sorted(filter(None, fields[2].split(",")))))
    roots = [entry for entry in selected.values() if entry["package"]["name"] == root_package]
    if len(roots) != 1:
        raise InventoryError(f"Expected exactly one root package {root_package}")
    return sorted(selected.values(), key=lambda item: (item["package"]["name"], item["package"]["version"], item["package"]["id"]))


def legal_name(path):
    return bool(re.fullmatch(
        r"(?:licen[cs]e|copying|notice|copyright|authors)(?:[-_.].*)?", path.name, re.IGNORECASE
    )) and path.suffix.lower() not in {".rs", ".py", ".c", ".h", ".json", ".toml"}


def legal_files(package_root, boundary, declared):
    candidates = set()
    for current, dirs, files in os.walk(package_root, followlinks=False):
        dirs[:] = sorted(name for name in dirs if name not in {".git", "target"})
        current = Path(current)
        in_legal_dir = any(part.lower() in {"licenses", "licences", "notices"} for part in current.relative_to(package_root).parts)
        for name in files:
            path = current / name
            if legal_name(path) or in_legal_dir:
                candidates.add(path)
    # Workspace/git members often inherit the repository-level LICENSE/NOTICE.
    parent = package_root.parent
    while parent.is_relative_to(boundary):
        candidates.update(path for path in parent.iterdir() if path.is_file() and legal_name(path))
        if parent == boundary:
            break
        parent = parent.parent
    if declared:
        candidates.add(package_root / declared)
    return sorted(candidates, key=lambda path: path.as_posix())


def package_record(entry, lock_packages, source_root, output):
    package = entry["package"]
    key = (package["name"], package["version"], package.get("source"))
    matches = [item for item in lock_packages if (item["name"], item["version"], item.get("source")) == key]
    if len(matches) != 1:
        raise InventoryError(f"Missing or conflicting Cargo.lock identity for {key}")
    locked = matches[0]
    manifest = Path(package["manifest_path"])
    package_root = manifest.parent.resolve()
    source = package.get("source")
    checksum = locked.get("checksum")
    if source is None:
        boundary = source_root
        if not package_root.is_relative_to(boundary):
            raise InventoryError(f"Local package outside --source-root: {manifest}")
        source_record = {"kind": "path", "path": package_root.relative_to(boundary).as_posix()}
    elif source.startswith(("registry+", "sparse+")):
        boundary = package_root
        if not isinstance(checksum, str) or not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise InventoryError(f"Missing registry checksum for {key}")
        checksum_file = package_root / ".cargo-checksum.json"
        if checksum_file.exists():
            actual = json.loads(read_file(checksum_file, boundary)).get("package")
            if actual != checksum:
                raise InventoryError(f"Conflicting registry checksum for {key}")
        source_record = {"kind": "registry", "id": source, "cargo_lock_checksum": checksum}
    elif source.startswith("git+"):
        revision = source.rsplit("#", 1)[-1]
        if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision):
            raise InventoryError(f"Unpinned Git source for {key}")
        boundary = Path(run(["git", "rev-parse", "--show-toplevel"], package_root).decode().strip()).resolve()
        actual = run(["git", "rev-parse", "HEAD"], package_root).decode().strip()
        if actual != revision:
            raise InventoryError(f"Conflicting Git checkout revision for {key}")
        source_record = {"kind": "git", "id": source, "revision": revision}
    else:
        raise InventoryError(f"Unsupported Cargo source, manual review required: {source}")
    manifest_bytes = read_file(manifest, boundary)
    declared = tomllib.loads(manifest_bytes.decode())["package"]
    license_expression = package.get("license")
    license_file = package.get("license_file")
    if not (isinstance(license_expression, str) and license_expression.strip()) and not license_file:
        raise InventoryError(f"Missing license/license-file metadata for {key}")
    manifest_license = declared.get("license")
    if isinstance(manifest_license, str) and manifest_license != license_expression:
        raise InventoryError(f"Conflicting manifest/metadata license for {key}")
    files = []
    for path in legal_files(package_root, boundary, license_file):
        data = read_file(path, boundary)
        if not data.strip():
            raise InventoryError(f"Empty license/notice evidence: {path}")
        digest = sha256(data)
        (output / "texts" / f"{digest}.txt").write_bytes(data)
        files.append({
            "path": path.relative_to(boundary).as_posix(),
            "sha256": digest,
            "text_file": f"texts/{digest}.txt",
            "declared_license_file": bool(license_file and path.resolve() == (package_root / license_file).resolve()),
            "symlink_target": os.readlink(path) if path.is_symlink() else None,
        })
    has_license_text = any(
        item["declared_license_file"]
        or re.match(r"licen[cs]e|copying", Path(item["path"]).name, re.I)
        or any(part.lower() in {"licenses", "licences"} for part in Path(item["path"]).parts[:-1])
        for item in files
    )
    if not has_license_text:
        raise InventoryError(f"No license text found for {key}; manual evidence required")
    return {
        "name": package["name"], "version": package["version"],
        "package_id": package["id"] if source else f"path:{source_record['path']}#{package['name']}@{package['version']}",
        "source": source_record, "manifest_sha256": sha256(manifest_bytes),
        "license_expression": license_expression, "declared_license_file": license_file,
        "repository": package.get("repository"), "links": package.get("links"),
        "feature_sets": [list(features) for features in sorted(entry["feature_sets"])],
        "license_notice_candidates": files,
    }


def collect(args):
    source_root = args.source_root.resolve()
    manifest = args.manifest_path.resolve()
    if not manifest.is_relative_to(source_root):
        raise InventoryError("The manifest must be inside --source-root")
    if args.target == "all" or not re.fullmatch(r"[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+){2,}", args.target):
        raise InventoryError("Use one explicit Rust target triple, never 'all'")
    if args.output.resolve().is_relative_to(source_root):
        raise InventoryError("Keep the output directory outside --source-root")
    before = source_identity(source_root)
    common = ["--manifest-path", str(manifest), "--locked", "--color", "never"]
    if args.offline:
        common.append("--offline")
    # Package identities must include conditional build-host dependencies too.
    # Filtering metadata only to a cross target can omit packages that Cargo's
    # target-specific production tree correctly includes for the build host.
    # The tree below, not the full metadata package list, selects the inventory.
    metadata_command = [args.cargo, "metadata", "--format-version", "1", *common]
    tree_command = [args.cargo, "tree", "--package", args.package, "--target", args.target, "--edges", "normal,build", "--prefix", "none", "--format", "{p}|{l}|{f}", *common]
    metadata_bytes = run(metadata_command, manifest.parent)
    tree_bytes = run(tree_command, manifest.parent)
    metadata = json.loads(metadata_bytes)
    lock_path = Path(metadata["workspace_root"]) / "Cargo.lock"
    lock_bytes = read_file(lock_path, source_root)
    selected = select_packages(metadata, tree_bytes.decode(), args.package)
    lock_packages = tomllib.loads(lock_bytes.decode())["package"]
    report = {
        "schema_version": 1, "status": "incomplete", "legal_completeness": "unverified",
        "scope": "Cargo production dependency tree, normal and build edges including proc macros; no dev edges",
        "limitations": [
            "Cargo tree is not proof of the exact linked binary contents.",
            "License expressions and text candidates require cargo-deny and human reconciliation.",
            "Native libraries, vendored assets, runtime downloads, and other non-Cargo components require separate review.",
            "Source fingerprint excludes Git-ignored files; build against the same reviewed source and environment.",
        ],
        "target": args.target, "root_package": args.package, "features": "default",
        "source": before, "cargo_version": run([args.cargo, "--version", "--verbose"], manifest.parent).decode().strip(),
        "inventory_script_sha256": sha256(Path(__file__).read_bytes()),
        "workspace_manifest_sha256": sha256(read_file(Path(metadata["workspace_root"]) / "Cargo.toml", source_root)),
        "selected_manifest_sha256": sha256(read_file(manifest, source_root)),
        "lock_sha256": sha256(lock_bytes),
        "evidence": {"cargo-metadata.json": sha256(metadata_bytes), "cargo-tree.txt": sha256(tree_bytes)},
        "commands": [metadata_command, tree_command], "packages": [], "unresolved_packages": [], "errors": [],
    }
    output = args.output.resolve()
    if output.exists():
        raise InventoryError(f"Output already exists; choose a new evidence directory: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".license-inventory-", dir=output.parent) as temporary:
        staging = Path(temporary)
        (staging / "texts").mkdir()
        (staging / "cargo-metadata.json").write_bytes(metadata_bytes)
        (staging / "cargo-tree.txt").write_bytes(tree_bytes)
        (staging / "Cargo.lock").write_bytes(lock_bytes)
        for entry in selected:
            try:
                report["packages"].append(package_record(entry, lock_packages, source_root, staging))
            except (InventoryError, OSError, ValueError, KeyError) as exc:
                package = entry["package"]
                report["errors"].append({"name": package["name"], "version": package["version"], "error": str(exc)})
                unresolved = {key: package.get(key) for key in ("id", "name", "version", "source", "license", "license_file", "manifest_path", "repository")}
                unresolved["cargo_lock_entries"] = [item for item in lock_packages if (item["name"], item["version"], item.get("source")) == (package["name"], package["version"], package.get("source"))]
                report["unresolved_packages"].append(unresolved)
        if source_identity(source_root) != before or read_file(lock_path, source_root) != lock_bytes:
            report["errors"].append({"error": "Source/lock changed during inventory; rerun on stable source"})
        report["selected_package_count"] = len(selected)
        if not report["errors"]:
            report["status"] = "source_inventory_collected"
        (staging / "inventory.json").write_text(json.dumps(report, indent=2, sort_keys=True) + "\n")
        # Destination did not exist; rename never mixes evidence from different runs.
        staging.rename(output)
    print(f"{report['status']}: {len(report['packages'])}/{len(selected)} packages; {len(report['errors'])} errors; legal completeness unverified")
    print(output / "inventory.json")
    return 1 if report["errors"] else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True, type=Path)
    parser.add_argument("--manifest-path", required=True, type=Path)
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--package", default="codex-cli")
    parser.add_argument("--cargo", default="cargo")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    try:
        return collect(args)
    except (InventoryError, OSError, ValueError, KeyError) as exc:
        print(f"License inventory failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
