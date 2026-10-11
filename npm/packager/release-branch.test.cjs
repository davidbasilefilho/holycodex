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
  assert.ok(sources[0].includes('release/v2.4.0/fix/windows-install'));
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

test('unimplemented operations are absent from the shipped and native expected skill inventories', () => {
  const skills = path.join(__dirname, '../../overlay/holycodex/skills');
  const shipped = fs.readdirSync(skills).filter((name) => fs.existsSync(path.join(skills, name, 'SKILL.md')));
  const metadataNames = shipped.map((name) => {
    const metadata = fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8');
    return /^name: (.+)$/m.exec(metadata)?.[1];
  });
  for (const removed of ['auto-reset', 'handoff']) {
    assert.ok(!shipped.includes(removed), `unimplemented ${removed} asset is still shipped`);
    assert.ok(!metadataNames.includes(removed), `unimplemented ${removed} is still advertised`);
  }
  const patch = fs.readFileSync(path.join(__dirname, '../../patches/0001-native-runtime.patch'), 'utf8');
  const inventory = /const HOLYCODEX_SKILLS: &\[&str\] = &\[([\s\S]*?)\+\s*\];/.exec(patch);
  assert.ok(inventory, 'native embedded-skill inventory test must remain present');
  const expected = [...inventory[1].matchAll(/^\+\s+"([^"]+)",$/gm)].map((match) => match[1]);
  assert.deepEqual(expected.toSorted(), shipped.toSorted());
});

test('real external tools and renderers require verified current availability', () => {
  const skills = path.join(__dirname, '../../overlay/holycodex/skills');
  const context7 = fs.readFileSync(path.join(skills, 'context7-cli/SKILL.md'), 'utf8');
  assert.ok(context7.includes('does not install or supply the Context7 CLI'));
  assert.ok(context7.includes('verify that it is available in the current environment'));
  assert.ok(context7.includes('official documentation'));
  const visualization = fs.readFileSync(path.join(skills, 'visualize/SKILL.md'), 'utf8');
  assert.ok(visualization.includes('capabilities actually exposed to the current account and workspace'));
  assert.doesNotMatch(visualization, /ChatGPT web and desktop support rich visualizations/);
});

test('usage docs distinguish shipped guidance from operations and omit future enforcement promises', () => {
  const root = path.join(__dirname, '../..');
  const instructions = fs.readFileSync(path.join(root, 'docs/INSTRUCTIONS.md'), 'utf8');
  assert.ok(instructions.includes('A bundled skill is guidance, not an installed integration or host operation'));
  const modelPolicy = fs.readFileSync(path.join(root, 'docs/MODEL-POLICY.md'), 'utf8');
  assert.ok(modelPolicy.includes('auto_reset'));
  assert.ok(modelPolicy.includes('remains accepted for configuration compatibility'));
  assert.ok(modelPolicy.includes('supplies no corresponding operation or active skill'));
  assert.doesNotMatch(modelPolicy, /enforcement is deferred|until the host can provide/);
});

test('HolyCodex recommended names and existing fix heads remain valid in the same stack', () => {
  const root = fs.readFileSync(path.join(__dirname, '../../overlay/holycodex/instructions/root.md'), 'utf8');
  assert.ok(root.includes('recommend `release/v0.17.0/windows-install`'));
  assert.deepEqual(parseReleaseBranch('release/v0.17.0/windows-install'), { version: '0.17.0', change: 'windows-install' });
  const existing = 'release/v0.17.0-rc.2/fix/assignment-revision-evidence';
  assert.deepEqual(parseReleaseBranch(existing, [existing]), { version: '0.17.0-rc.2', change: 'fix/assignment-revision-evidence' });
  assert.equal(validateReleaseStack([
    { head: existing, base: 'main' },
    { head: 'release/v0.17.0-rc.2/polling-deadline', base: existing },
  ], [existing]).layers, 2);
  for (const head of ['release/v0.17.0/feat/new-work', 'release/v0.17.0/fix/nested/change']) {
    assert.throws(() => parseReleaseBranch(head), /release branch/);
  }
});


test('only exact inventoried four-segment identities receive compatibility', () => {
  // Published PR #25 and #26 heads, kept verbatim rather than renamed.
  const existing = [
    'release/v0.17.0/fix/assignment-revision-evidence',
    'release/v0.17.0/fix/assignment-acceptance',
  ];
  const original = [...existing];
  const layers = existing.map((head, index) => ({ head, base: index ? existing[index - 1] : 'main' }));
  assert.equal(validateReleaseStack(layers, existing).tip, existing[1]);
  for (const head of [...existing, 'release/v0.17.0/fix/brand-new-layer']) {
    assert.throws(() => parseReleaseBranch(head), /must already exist/);
    assert.throws(() => validateReleaseStack([{ head, base: 'main' }]), /must already exist/);
  }
  for (const head of ['release/v0.17.0/fix/brand-new-layer',
    'release/v0.17.0-rc.2/fix/assignment-acceptance',
    'release/v0.17.0+build.1/fix/assignment-acceptance']) {
    assert.throws(() => parseReleaseBranch(head, existing), /must already exist/);
    assert.throws(() => validateReleaseStack([...layers, { head, base: existing[1] }], existing), /must already exist/);
  }
  assert.deepEqual(existing, original);
  assert.equal(validateReleaseStack([...layers, {
    head: 'release/v0.17.0/new-layer', base: existing[1],
  }], existing).layers, 3);
});
