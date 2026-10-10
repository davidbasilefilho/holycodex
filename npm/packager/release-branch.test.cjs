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
  for (const phrase of ['release/<version>/<type>/<change>', 'exp/<experiment>/<type>/<change>',
    'preserve optional version suffixes',
    'one branch and one PR per substantial change', 'immediate predecessor',
    'Git prefix collision', 'does not authorize merge, publication, deployment, or security-setting changes']) {
    assert.ok(instructions.includes(phrase), `missing canonical release rule: ${phrase}`);
  }
  assert.doesNotMatch(instructions, /release\/v[^\s`]*\/integration/);
});

test('Root follows the target codebase before choosing the approved fallback families', () => {
  const instructions = fs.readFileSync(path.join(__dirname, '../../overlay/holycodex/instructions/root.md'), 'utf8');
  const conventions = instructions.indexOf('Follow the target codebase\'s established branch and PR conventions first');
  const fallback = instructions.indexOf('release/<version>/<type>/<change>');
  assert.ok(conventions >= 0 && conventions < fallback, 'codebase conventions must precede the fallback');
  for (const phrase of ['If no applicable convention exists', 'only these fallback families',
    'compatible with the project\'s versioning and workflow triggers',
    'preserve mergeability', 'examples do not define a mandatory type catalog',
    'Do not rename an already valid branch merely to adopt the fallback',
    'For HolyCodex\'s own release stack, use the tested release-stack validator']) {
    assert.ok(instructions.includes(phrase), `missing branch scope: ${phrase}`);
  }
  assert.doesNotMatch(instructions, /use .*with a zero-major version/);
});

test('Root and policy docs agree on the two four-segment fallback families', () => {
  const root = path.join(__dirname, '../..');
  const sources = [
    fs.readFileSync(path.join(root, 'overlay/holycodex/instructions/root.md'), 'utf8'),
    fs.readFileSync(path.join(root, 'docs/INSTRUCTIONS.md'), 'utf8'),
    fs.readFileSync(path.join(root, 'docs/BRANCHES.md'), 'utf8').split('## HolyCodex repository convention')[0],
  ];
  for (const source of sources) {
    const families = [...source.matchAll(/`([a-z]+\/<[^`]+>)`/g)].map((match) => match[1]);
    assert.deepEqual(families, ['release/<version>/<type>/<change>', 'exp/<experiment>/<type>/<change>']);
  }
  assert.ok(sources[0].includes('release/v0.17.0/fix/windows-install'));
  assert.ok(sources[0].includes('exp/sqlite-history/feat/storage'));
  assert.ok(sources[0].includes('actual PR bases and dependencies determine the stack'));
  const scenarios = fs.readFileSync(path.join(root, 'crates/holycodex-policy/evals/mergeability.md'), 'utf8');
  assert.ok(scenarios.includes('release/v2.4.0-rc.1/fix/windows-install'));
  assert.ok(scenarios.includes('exp/sqlite-history/feat/storage'));
  assert.match(scenarios, /Keep the\s+existing repository-specific release validator unchanged/);
});

test('durable instructions are US English and derive authority from the current owner', () => {
  const instructions = fs.readFileSync(path.join(__dirname, '../../overlay/holycodex/instructions/root.md'), 'utf8');
  for (const phrase of ['Serve the current owner and the projects they authorize',
    'never import another owner\'s settings or approvals',
    'Write durable model-facing instructions in US English',
    'use the requested language for user-facing work']) {
    assert.ok(instructions.includes(phrase), `missing owner-neutral instruction: ${phrase}`);
  }
  assert.doesNotMatch(instructions, /davidbasilefilho|C:\\Users\\basile|\bholydot\b/i);
  const development = fs.readFileSync(path.join(__dirname, '../../docs/DEVELOPMENT.md'), 'utf8');
  assert.doesNotMatch(development, /[A-Z]:\\Users\\[^\s]+/i);
  assert.equal((development.match(/--upstream \.\.\/holycodex-upstream/g) || []).length, 3);
});
