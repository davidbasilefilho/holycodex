'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.17.0-1';
const PLATFORMS = {
  'holycodex-native-linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  'holycodex-native-darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
  'holycodex-native-win32-x64': { os: ['win32'], cpu: ['x64'] },
};

function readSourceRevision(filename) {
  const match = /^source_sha = "([a-f0-9]{40,64})"\n?$/.exec(fs.readFileSync(filename, 'utf8'));
  assert.ok(match, `${filename}: invalid source-revision.toml`);
  return match[1];
}

function tarFile(archive, name) {
  return execFileSync('tar', ['-xzOf', archive, `package/${name}`]);
}

function verifyRelease(artifactRoot, expectedSha) {
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
    assert.equal(metadata.version, VERSION, `${directory}: package version mismatch`);
    assert.equal(archives[0], `${metadata.name}-${VERSION}.tgz`, `${directory}: tarball name mismatch`);
    for (const name of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
      assert.ok(tarFile(archive, name).length > 0, `${directory}: missing ${name}`);
    }
    assert.ok(!packages.has(metadata.name), `${directory}: duplicate ${metadata.name}`);
    packages.add(metadata.name);

    if (metadata.name === 'holycodex') {
      assert.deepEqual(metadata.optionalDependencies, {
        'holycodex-native-darwin-arm64': VERSION,
        'holycodex-native-linux-x64-gnu': VERSION,
        'holycodex-native-win32-x64': VERSION,
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
    assert.equal(match[2], VERSION);
    const extension = metadata.name === 'holycodex-native-win32-x64' ? '.exe' : '';
    const holy = tarFile(archive, `bin/holycodex${extension}`);
    const codex = tarFile(archive, `bin/codex${extension}`);
    assert.ok(holy.length > 0, `${directory}: empty native executable`);
    assert.ok(holy.equals(codex), `${directory}: executable aliases differ`);
    assert.equal(createHash('sha256').update(holy).digest('hex'), match[3],
      `${directory}: payload digest mismatch`);
  }

  assert.deepEqual([...packages].sort(), ['holycodex', ...Object.keys(PLATFORMS)].sort());
}

if (require.main === module) {
  const [artifactRoot, expectedSha] = process.argv.slice(2);
  if (!artifactRoot || !expectedSha || process.argv.length !== 4) {
    throw new Error('usage: node verify-release.cjs ARTIFACT_DIRECTORY VERIFIED_SHA');
  }
  verifyRelease(artifactRoot, expectedSha);
  console.log(`Verified four HolyCodex ${VERSION} npm artifacts from ${expectedSha}.`);
}

module.exports = { readSourceRevision, verifyRelease };
