'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE_VERSION = '0.17.0';
const RELEASE_BRANCH = `release/v${BASE_VERSION}/release-routing`;
const PLATFORM_PACKAGES = [
  '@turndev/holycodex-native-darwin-arm64',
  '@turndev/holycodex-native-linux-x64-gnu',
  '@turndev/holycodex-native-win32-x64',
];

function validateVersion(version, channel) {
  const stable = version === BASE_VERSION;
  const dev = /^0\.17\.0-dev\.[1-9][0-9]*$/.test(version);
  assert.ok(stable || dev, 'invalid HolyCodex distribution version');
  if (channel) assert.ok(channel === 'dev' ? dev : channel === 'stable' && stable,
    'version must match the selected channel');
}

function distributionVersion(channel, runId, requested) {
  assert.ok(['dev', 'stable'].includes(channel), 'unknown publication channel');
  assert.match(runId, /^[1-9][0-9]*$/, 'invalid workflow run identity');
  const expected = channel === 'dev' ? `${BASE_VERSION}-dev.${runId}` : BASE_VERSION;
  const version = requested === undefined || requested === '' ? expected : requested;
  validateVersion(version, channel);
  assert.equal(version, expected, 'version must match the current workflow run');
  return version;
}

function publicationRoute(event, ref, publishDev = false) {
  assert.equal(typeof publishDev, 'boolean', 'DEV publication approval must be explicit');
  if (event === 'workflow_dispatch') {
    assert.equal(ref, `refs/heads/${RELEASE_BRANCH}`, 'DEV dispatch requires the accepted release branch');
    assert.equal(publishDev, true, 'DEV dispatch requires explicit publication approval');
    return { channel: 'dev', publish: true };
  }
  assert.equal(event, 'push', 'unsupported publication event');
  assert.equal(publishDev, false, 'explicit DEV publication requires manual dispatch');
  // Consolidation and ordinary review pushes validate without registry writes.
  if (ref === `refs/heads/${RELEASE_BRANCH}`) return { channel: 'dev', publish: false };
  if (ref === `refs/tags/v${BASE_VERSION}`) return { channel: 'stable', publish: true };
  throw new Error('DEV validation requires the release branch; stable requires accepted release tag push');
}

function tarballName(name, version) {
  assert.ok(name === 'holycodex' || PLATFORM_PACKAGES.includes(name), 'unknown package');
  validateVersion(version);
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

// Adjust only staged distribution metadata; source/runtime version stays pinned.
function stageChannel(directory, version, channel) {
  validateVersion(version, channel);
  const filename = path.join(directory, 'package.json');
  const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(metadata.version, BASE_VERSION, 'stage input must be the canonical base version');
  assert.ok(metadata.name === 'holycodex' || PLATFORM_PACKAGES.includes(metadata.name));
  metadata.version = version;
  metadata.publishConfig = { access: 'public', tag: channel === 'dev' ? 'dev' : 'latest' };
  if (metadata.name === 'holycodex') {
    assert.deepEqual(metadata.optionalDependencies,
      Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, BASE_VERSION])));
    metadata.optionalDependencies = Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, version]));
  } else {
    const proof = path.join(directory, 'payload.toml');
    const text = fs.readFileSync(proof, 'utf8');
    assert.ok(text.includes(`package = "${metadata.name}"\nversion = "${BASE_VERSION}"\n`));
    fs.writeFileSync(proof, text.replace(`version = "${BASE_VERSION}"`, `version = "${version}"`));
  }
  fs.writeFileSync(filename, JSON.stringify(metadata, null, 2) + '\n');
}

if (require.main === module) {
  const [operation, first, second, third, fourth] = process.argv.slice(2);
  if (operation === 'stage') stageChannel(first, second, third);
  else if (operation === 'version') console.log(distributionVersion(first, second, third));
  else if (operation === 'route') {
    assert.ok([undefined, '', 'false', 'true'].includes(fourth), 'invalid DEV publication approval');
    const route = publicationRoute(first, second, fourth === 'true');
    const version = distributionVersion(route.channel, third);
    console.log(`channel=${route.channel}\npublish=${route.publish}\nversion=${version}`);
  } else throw new Error('usage: channel.cjs stage DIRECTORY VERSION CHANNEL | version CHANNEL RUN_ID [VERSION] | route EVENT REF RUN_ID [PUBLISH_DEV]');
}

module.exports = { BASE_VERSION, RELEASE_BRANCH, PLATFORM_PACKAGES, validateVersion, distributionVersion, tarballName, stageChannel, publicationRoute };
