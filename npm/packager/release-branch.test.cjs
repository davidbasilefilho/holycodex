'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseReleaseBranch, validateReleaseStack } = require('./release-branch.cjs');

const stack = (version = '0.17.0') => [
  { head: `release/v${version}/native-auth`, base: 'main' },
  { head: `release/v${version}/sandbox-packaging`, base: `release/v${version}/native-auth` },
  { head: `release/v${version}/trusted-publishing`, base: `release/v${version}/sandbox-packaging` },
];

test('release branch identity preserves valid optional version suffixes', () => {
  for (const version of ['0.17.0', '0.17.0-1', '0.17.0-rc.2', '0.18.1+build.7']) {
    assert.deepEqual(parseReleaseBranch(`release/v${version}/native-auth`), { version, change: 'native-auth' });
    assert.equal(validateReleaseStack(stack(version)).version, version);
  }
});

test('bare prefixes, arbitrary sequence labels, malformed versions and nested slugs are rejected', () => {
  for (const name of ['next', 'release/v0.17.0', 'release/0.17.0/native-auth', 'release/v1.17.0/native-auth',
    'release/v0.017.0/native-auth', 'release/v0.17.00/native-auth', 'release/v0.17.0-01/native-auth',
    'release/v0.17.0-/native-auth', 'release/v0.17.0/01-native-auth', 'release/v0.17.0/native_auth',
    'release/v0.17.0/native-auth/extra', 'release/v0.17.0/../main']) {
    assert.throws(() => parseReleaseBranch(name), /release branch|version|prerelease/);
  }
});

test('a stack is separate PRs targeting the preceding layer; a single change needs only one PR', () => {
  assert.deepEqual(validateReleaseStack(stack()), {
    version: '0.17.0', base: 'main', tip: 'release/v0.17.0/trusted-publishing', layers: 3,
  });
  assert.equal(validateReleaseStack(stack().slice(0, 1)).layers, 1);
  assert.throws(() => validateReleaseStack([stack()[0], { ...stack()[1], base: 'main' }]), /immediate predecessor/);
  assert.throws(() => validateReleaseStack([stack()[0], stack()[0]]), /duplicate/);
  assert.throws(() => validateReleaseStack([stack()[0], { head: 'release/v0.17.0-1/sandbox-packaging', base: stack()[0].head }]), /exact release version/);
});

test('namespace collision is fail-closed without renaming, deleting or rewriting any ref', () => {
  const inventory = ['main', 'release/v0.17.0'];
  const original = [...inventory];
  assert.throws(() => validateReleaseStack(stack(), inventory), /prefix collision/);
  assert.deepEqual(inventory, original);
  assert.throws(() => validateReleaseStack(stack(), ['release/v0.17.0/native-auth/child']), /prefix collision/);
  assert.equal(validateReleaseStack(stack(), ['main', 'release/v0.17.0-1/native-auth']).layers, 3);
});

test('canonical Root instructions own release naming, PR dependencies and unchanged authorization boundaries', () => {
  const instructions = fs.readFileSync(path.join(__dirname, '../../overlay/holycodex/instructions/root.md'), 'utf8');
  for (const phrase of ['release/v<version>/<semantic-change>', 'preserve optional version suffixes',
    'one branch and one PR per substantial change', 'immediate predecessor',
    'Git prefix collision', 'does not authorize merge, publication, deployment, or security-setting changes']) {
    assert.ok(instructions.includes(phrase), `missing canonical release rule: ${phrase}`);
  }
  assert.doesNotMatch(instructions, /release\/v[^\s`]*\/integration/);
});
