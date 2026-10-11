'use strict';

const assert = require('node:assert/strict');

// Names are identities: never strip a prerelease/build suffix or invent order
// numbers. This checker describes a plan; it does not create refs or publish.
function parseReleaseBranch(name) {
  assert.equal(typeof name, 'string', 'release branch must be a string');
  // Preserve the existing /fix/ stack heads; new layers use the three-segment convention.
  const match = /^release\/v([^/]+)\/((?:fix\/)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/.exec(name);
  assert.ok(match, 'release branch requires release/v<version>/<semantic-change>');
  const version = match[1];
  const semver = /^0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(version);
  assert.ok(semver, 'HolyCodex release version must be zero-major SemVer');
  for (const identifier of (semver[3] || '').split('.')) {
    assert.ok(!/^[0-9]+$/.test(identifier) || identifier === '0' || !identifier.startsWith('0'),
      'numeric prerelease identifiers must not have leading zeroes');
  }
  return { version, change: match[2] };
}

function validateReleaseStack(layers, existingBranches = [], baseBranch = 'main') {
  assert.ok(Array.isArray(layers) && layers.length > 0, 'a release plan needs at least one PR layer');
  assert.ok(Array.isArray(existingBranches), 'existing branch inventory is required');
  const heads = new Set();
  let version;
  let expectedBase = baseBranch;
  for (const layer of layers) {
    const parsed = parseReleaseBranch(layer.head);
    version ??= parsed.version;
    assert.equal(parsed.version, version, 'stack layers must preserve the exact release version including suffix');
    assert.ok(!heads.has(layer.head), 'duplicate release PR head');
    assert.equal(layer.base, expectedBase, 'each PR must target its immediate predecessor, starting at the accepted base');
    assert.notEqual(layer.head, layer.base, 'a PR cannot target itself');
    heads.add(layer.head);
    expectedBase = layer.head;
  }
  const refs = [...new Set([...existingBranches, ...heads])];
  for (const head of heads) {
    assert.equal(refs.some((other) => other !== head &&
      (head.startsWith(`${other}/`) || other.startsWith(`${head}/`))), false,
    'Git branch prefix collision: rename the existing prefix to a semantic layer before creating descendants');
  }
  return { version, base: baseBranch, tip: expectedBase, layers: layers.length };
}

module.exports = { parseReleaseBranch, validateReleaseStack };
