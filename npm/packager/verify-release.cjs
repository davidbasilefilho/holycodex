'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const BASE_VERSION = '0.17.0-1';
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
  return execFileSync('tar', ['-xzOf', archive, `package/${name}`]);
}

// Redirect large native members to private files; compare/hash bounded chunks.
// Metadata stays buffered, while executable size cannot exhaust spawnSync stdout.
function verifyNativeAliases(archive, extension, expectedDigest, artifactDirectory) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-native-proof-'));
  const readers = [];
  try {
    for (const alias of ['holycodex', 'codex']) {
      const filename = path.join(temporary, alias);
      const output = fs.openSync(filename, 'wx', 0o600);
      try {
        execFileSync('tar', ['-xzOf', archive, `package/bin/${alias}${extension}`],
          { stdio: ['ignore', output, 'pipe'] });
      } finally {
        fs.closeSync(output);
      }
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

module.exports = { readSourceRevision, verifyRelease };
