'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const workflow = (name) => fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');

test('upstream compatibility PRs use read-only artifact validation without publication', () => {
  const native = workflow('native-validation.yml');
  assert.match(native, /  pull_request:\n    paths:\n      - upstream\.toml\n      - patches\/\*\*/);
  assert.doesNotMatch(native, /pull_request_target/);
  assert.match(native, /cancel-in-progress: true/);
  assert.match(native, /uses: \.\/\.github\/workflows\/dev\.yml/);
  assert.match(workflow('dev.yml'), /uses: \.\/\.github\/workflows\/release\.yml/);
  for (const name of ['native-validation.yml', 'dev.yml', 'release.yml']) {
    const source = workflow(name);
    assert.match(source, /permissions:\n  contents: read/);
    assert.doesNotMatch(source, /(?:contents|actions|id-token): write/);
    assert.doesNotMatch(source, /uses: \.\/\.github\/workflows\/(?:publish|stable)\.yml/);
    assert.doesNotMatch(source, /(?:npm publish|gh release create|npm\/packager\/publish\.cjs)/);
  }
});

test('native validation checkouts and artifact proofs use the same immutable candidate', () => {
  for (const name of ['native-validation.yml', 'release.yml']) {
    const source = workflow(name);
    const checkouts = source.split(/- uses: actions\/checkout@/).slice(1);
    assert.ok(checkouts.length > 0, name);
    for (const checkout of checkouts) {
      const settings = checkout.split(/\n      - /)[0];
      assert.match(settings, /ref: \$\{\{ github\.sha \}\}/);
      assert.match(settings, /persist-credentials: false/);
    }
  }
  const release = workflow('release.yml');
  assert.match(release, /test "\$actual" = "\$GITHUB_SHA"/);
  assert.match(release, /needs: \[prepare, wrapper, native\]/);
  assert.match(release, /verify-release\.cjs \.tmp\/release-artifacts "\$GITHUB_SHA"/);
});
