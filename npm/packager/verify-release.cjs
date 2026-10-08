'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE_VERSION = '0.17.0-1';
// Both compatibility entrypoints remain full native files. These bounds allow
// release growth but reject accidental distribution of debug-heavy binaries.
const MAX_NATIVE_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

function verifyArchiveSize(archive) {
  const size = fs.statSync(archive).size;
  assert.ok(size > 0 && size <= MAX_ARCHIVE_BYTES,
    `${archive}: npm tarball exceeds the 256 MiB release limit or is empty`);
  return size;
}
const { validateVersion, tarballName } = require('./channel.cjs');
const PLATFORMS = {
  '@turndev/holycodex-native-linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  '@turndev/holycodex-native-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
  '@turndev/holycodex-native-win32-x64': { os: ['win32'], cpu: ['x64'] },
};

function readSourceRevision(filename) {
  const match = /^source_sha = "([a-f0-9]{40,64})"\n?$/.exec(fs.readFileSync(filename, 'utf8'));
  assert.ok(match, `${filename}: invalid source-revision.toml`);
  return match[1];
}

function tarFile(archive, name) {
  // A basename relative to cwd avoids GNU tar treating a Windows drive colon
  // as a remote host; ./ also protects colon-bearing local archive names.
  return execFileSync('tar', ['-xzOf', `./${path.basename(archive)}`, `package/${name}`],
    { cwd: path.dirname(path.resolve(archive)) });
}

// Redirect large native members to private files; compare/hash bounded chunks.
// Metadata stays buffered, while executable size cannot exhaust spawnSync stdout.
function verifyNativeAliases(archive, extension, expectedDigest, artifactDirectory, inspect) {
  verifyArchiveSize(archive);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-native-proof-'));
  const readers = [];
  const filenames = [];
  try {
    for (const alias of ['holycodex', 'codex']) {
      const filename = path.join(temporary, alias + extension);
      filenames.push(filename);
      const output = fs.openSync(filename, 'wx', 0o600);
      try {
        execFileSync('tar', ['-xzOf', `./${path.basename(archive)}`, `package/bin/${alias}${extension}`],
          { cwd: path.dirname(path.resolve(archive)), stdio: ['ignore', output, 'pipe'] });
      } finally {
        fs.closeSync(output);
      }
      const size = fs.statSync(filename).size;
      assert.ok(size > 0 && size <= MAX_NATIVE_BYTES,
        `${artifactDirectory}: native executable exceeds the 256 MiB release limit or is empty`);
      readers.push(fs.openSync(filename, 'r'));
    }
    const left = Buffer.alloc(64 * 1024);
    const right = Buffer.alloc(left.length);
    const digest = createHash('sha256');
    let size = 0;
    while (true) {
      const count = fs.readSync(readers[0], left, 0, left.length, null);
      const other = fs.readSync(readers[1], right, 0, right.length, null);
      assert.equal(count, other, `${artifactDirectory}: executable aliases differ`);
      if (count === 0) break;
      assert.ok(left.subarray(0, count).equals(right.subarray(0, other)),
        `${artifactDirectory}: executable aliases differ`);
      digest.update(left.subarray(0, count));
      size += count;
    }
    assert.ok(size > 0, `${artifactDirectory}: empty native executable`);
    assert.equal(digest.digest('hex'), expectedDigest, `${artifactDirectory}: payload digest mismatch`);
    // Inspect only verified bytes, while their private files still exist. The
    // optional callback is used by the native runner, never by publication.
    if (inspect) inspect(filenames, size);
    return size;
  } finally {
    for (const reader of readers) fs.closeSync(reader);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function verifyRelease(artifactRoot, expectedSha, version = BASE_VERSION) {
  validateVersion(version);
  assert.match(expectedSha, /^[a-f0-9]{40,64}$/);
  const artifacts = fs.readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(artifactRoot, entry.name));
  assert.equal(artifacts.length, 4, 'expected wrapper and three platform artifacts');

  const packages = new Set();
  for (const directory of artifacts) {
    assert.equal(readSourceRevision(path.join(directory, 'source-revision.toml')), expectedSha,
      `${directory}: source SHA differs from validated workflow SHA`);
    const archives = fs.readdirSync(directory).filter((name) => name.endsWith('.tgz'));
    assert.equal(archives.length, 1, `${directory}: expected exactly one npm tarball`);
    const archive = path.join(directory, archives[0]);
    verifyArchiveSize(archive);
    const metadata = JSON.parse(tarFile(archive, 'package.json'));
    assert.equal(metadata.repository?.url, 'git+https://github.com/davidbasilefilho/holycodex.git', `${directory}: provenance repository mismatch`);
    assert.deepEqual(metadata.publishConfig, { access: 'public', tag: version === BASE_VERSION ? 'latest' : 'dev' }, `${directory}: distribution channel mismatch`);
    assert.equal(metadata.version, version, `${directory}: package version mismatch`);
    assert.equal(archives[0], tarballName(metadata.name, version), `${directory}: tarball name mismatch`);
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
      assert.ok(tarFile(archive, name).length > 0, `${directory}: missing ${name}`);
    }
    assert.ok(!packages.has(metadata.name), `${directory}: duplicate ${metadata.name}`);
    packages.add(metadata.name);

    if (metadata.name === 'holycodex') {
      assert.deepEqual(metadata.optionalDependencies, {
        '@turndev/holycodex-native-darwin-arm64': version,
        '@turndev/holycodex-native-linux-x64-gnu': version,
        '@turndev/holycodex-native-win32-x64': version,
      });
      continue;
    }

    assert.ok(Object.hasOwn(PLATFORMS, metadata.name), `${directory}: unexpected npm package ${metadata.name}`);
    const target = PLATFORMS[metadata.name];
    for (const field of ['os', 'cpu', 'libc']) {
      if (target[field]) assert.deepEqual(metadata[field], target[field], `${directory}: ${field} mismatch`);
      else assert.equal(metadata[field], undefined, `${directory}: unexpected ${field}`);
    }
    const manifestText = tarFile(archive, 'payload.toml').toString('utf8');
    const match = /^format = 1\npackage = "([^"\r\n]+)"\nversion = "([^"\r\n]+)"\nsha256 = "([a-f0-9]{64})"\n?$/.exec(manifestText);
    assert.ok(match, `${directory}: invalid payload.toml`);
    assert.equal(match[1], metadata.name);
    assert.equal(match[2], version);
    const extension = metadata.name === '@turndev/holycodex-native-win32-x64' ? '.exe' : '';
    verifyNativeAliases(archive, extension, match[3], directory);
  }

  assert.deepEqual([...packages].sort(), ['holycodex', ...Object.keys(PLATFORMS)].sort());
}

if (require.main === module) {
  const [artifactRoot, expectedSha, version = BASE_VERSION] = process.argv.slice(2);
  if (!artifactRoot || !expectedSha || ![4, 5].includes(process.argv.length)) {
    throw new Error('usage: node verify-release.cjs ARTIFACT_DIRECTORY VERIFIED_SHA [VERSION]');
  }
  verifyRelease(artifactRoot, expectedSha, version);
  console.log(`Verified four HolyCodex ${version} npm artifacts from ${expectedSha}.`);
}

module.exports = { readSourceRevision, verifyRelease, verifyNativeAliases, verifyArchiveSize, tarFile, MAX_NATIVE_BYTES, MAX_ARCHIVE_BYTES };
