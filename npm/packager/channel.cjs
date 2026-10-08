'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE_VERSION = '0.17.0-1';
const PLATFORM_PACKAGES = [
  '@turndev/holycodex-native-darwin-arm64',
  '@turndev/holycodex-native-linux-x64-gnu',
  '@turndev/holycodex-native-win32-x64',
];

function validateVersion(version, channel) {
  const stable = version === BASE_VERSION;
  const dev = /^0\.17\.0-1\.dev\.[1-9][0-9]*$/.test(version);
  assert.ok(stable || dev, 'invalid HolyCodex distribution version');
  if (channel) assert.ok(channel === 'dev' ? dev : channel === 'stable' && stable,
    'version must match the selected channel');
}

function distributionVersion(channel, runId, requested) {
  assert.ok(['dev', 'stable'].includes(channel), 'unknown publication channel');
  assert.match(runId, /^[1-9][0-9]*$/, 'invalid workflow run identity');
  const version = requested || (channel === 'dev' ? `${BASE_VERSION}.dev.${runId}` : BASE_VERSION);
  validateVersion(version, channel);
  return version;
}

function publicationRoute(event, ref) {
  assert.equal(event, 'push', 'publication requires a push event');
  if (ref === 'refs/heads/next') return { channel: 'dev', publish: true };
  if (ref === 'refs/tags/v0.17.0-1') return { channel: 'stable', publish: true };
  throw new Error('DEV publishing requires next; stable requires accepted release tag push');
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
  const [operation, first, second, third] = process.argv.slice(2);
  if (operation === 'stage') stageChannel(first, second, third);
  else if (operation === 'version') console.log(distributionVersion(first, second, third));
  else if (operation === 'route') {
    const route = publicationRoute(first, second);
    const version = distributionVersion(route.channel, third);
    console.log(`channel=${route.channel}\npublish=${route.publish}\nversion=${version}`);
  } else throw new Error('usage: channel.cjs stage DIRECTORY VERSION CHANNEL | version CHANNEL RUN_ID [VERSION] | route EVENT REF RUN_ID');
}

module.exports = { BASE_VERSION, PLATFORM_PACKAGES, validateVersion, distributionVersion, tarballName, stageChannel, publicationRoute };
