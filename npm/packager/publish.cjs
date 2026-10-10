'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PLATFORM_PACKAGES, validateVersion, tarballName } = require('./channel.cjs');
const { verifyRelease } = require('./verify-release.cjs');

async function registryPackage(name) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(30000) });
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `registry read failed for ${name}: HTTP ${response.status}`);
  return response.json();
}

// Publishing is deliberately sequential. Never expose the wrapper until every
// exact native version and integrity has been read back from the registry.
async function publishPackages(root, sha, version, channel, adapter = {}) {
  validateVersion(version, channel);
  verifyRelease(root, sha, version);
  const read = adapter.read || registryPackage;
  const publish = adapter.publish || ((archive, tag) => execFileSync('npm',
    ['publish', archive, '--access', 'public', '--tag', tag, '--provenance'], { stdio: 'inherit' }));
  const wait = adapter.wait || (() => new Promise((resolve) => setTimeout(resolve, 5000)));
  const tag = channel === 'dev' ? 'dev' : 'latest';
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  const entries = [];
  for (const name of [...PLATFORM_PACKAGES, 'holycodex']) {
    const candidates = directories.map((directory) => path.join(directory, tarballName(name, version)))
      .filter((filename) => fs.existsSync(filename));
    assert.equal(candidates.length, 1, `expected one archive for ${name}`);
    const archive = candidates[0];
    const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
    const metadata = await read(name);
    assert.ok(metadata, `${name} is absent: owner must bootstrap the package and configure publish.yml trusted publishing before any automated publish`);
    assert.equal(metadata.name, name, 'registry package identity mismatch');
    const existing = metadata.versions?.[version];
    if (existing) {
      assert.equal(existing.dist?.integrity, integrity, `existing ${name}@${version} differs from validated artifact`);
      assert.equal(metadata['dist-tags']?.[tag], version, `existing ${name}@${version} does not have ${tag}; owner must reconcile the dist-tag`);
    }
    entries.push({ name, archive, integrity, existing: Boolean(existing), latest: metadata['dist-tags']?.latest });
  }

  for (const entry of entries) {
    if (!entry.existing) await publish(entry.archive, tag);
    let confirmed = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const metadata = await read(entry.name);
      if (metadata?.versions?.[version]?.dist?.integrity === entry.integrity
          && metadata['dist-tags']?.[tag] === version) {
        if (channel === 'dev') assert.equal(metadata['dist-tags']?.latest, entry.latest,
          `DEV unexpectedly changed latest for ${entry.name}`);
        confirmed = true;
        break;
      }
      if (attempt < 5) await wait();
    }
    assert.ok(confirmed, `${entry.name}@${version} integrity/tag readback failed; wrapper publication is withheld`);
  }
}

if (require.main === module) {
  const [root, sha, version, channel] = process.argv.slice(2);
  publishPackages(root, sha, version, channel).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { publishPackages };
