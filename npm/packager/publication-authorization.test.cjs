'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { authorizePublication } = require('./publication-authorization.cjs');

function context(overrides = {}) {
  const env = {
    GITHUB_REPOSITORY: 'davidbasilefilho/holycodex',
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/release/v0.17.0/release-routing',
    GITHUB_ACTOR: 'davidbasilefilho',
    GITHUB_TRIGGERING_ACTOR: 'davidbasilefilho',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_SHA: 'a'.repeat(40),
    GITHUB_RUN_ID: '123',
    PUBLISH_DEV: 'true',
    ...overrides,
  };
  env.GITHUB_WORKFLOW_REF ??= `${env.GITHUB_REPOSITORY}/.github/workflows/publish.yml@${env.GITHUB_REF}`;
  return env;
}

for (const channel of ['dev', 'stable']) {
  const base = channel === 'dev' ? {} : {
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.17.0', PUBLISH_DEV: 'false',
  };
  test(`${channel}: owner initiation and rerun remain authorized`, () => {
    assert.deepEqual(authorizePublication(context(base)), {
      channel, publish: true, version: channel === 'dev' ? '0.17.0-dev.123' : '0.17.0',
    });
  });
  for (const key of ['GITHUB_ACTOR', 'GITHUB_TRIGGERING_ACTOR']) {
    for (const actor of [undefined, '', 'collaborator', 'github-actions[bot]', 'DAVIDBASILEFILHO']) {
      test(`${channel}: rejects ${key}=${String(actor)}`, () => {
        assert.throws(() => authorizePublication(context({ ...base, [key]: actor })), /release owner/);
      });
    }
  }
}

test('release branch pushes by other actors only validate', () => {
  assert.equal(authorizePublication(context({ GITHUB_EVENT_NAME: 'push', PUBLISH_DEV: 'false',
    GITHUB_ACTOR: 'reviewer', GITHUB_TRIGGERING_ACTOR: 'reviewer' })).publish, false);
});

test('unsupported events, refs, implicit approval and foreign sources fail closed', () => {
  for (const override of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_run' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/codex/native-validation/review', PUBLISH_DEV: 'false' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v0.17.1', PUBLISH_DEV: 'false' },
    { GITHUB_REF: 'refs/tags/v0.17.0' },
    { GITHUB_REF: 'refs/heads/main' },
    { PUBLISH_DEV: 'false' }, { PUBLISH_DEV: undefined }, { PUBLISH_DEV: '1' },
    { GITHUB_REPOSITORY: 'attacker/holycodex' },
    { GITHUB_WORKFLOW_REF: 'davidbasilefilho/holycodex/.github/workflows/native-validation.yml@refs/heads/main' },
    { GITHUB_SHA: '' }, { GITHUB_WORKFLOW_SHA: 'b'.repeat(40) },
    { GITHUB_WORKFLOW_SHA: undefined },
  ]) assert.throws(() => authorizePublication(context(override)), JSON.stringify(override));
});

test('workflow gates authorization before validation and again before publication', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/publish.yml'), 'utf8');
  assert.equal(workflow.match(/node npm\/packager\/publication-authorization.cjs/g).length, 2);
  const publish = workflow.slice(workflow.indexOf('\n  publish:\n'));
  assert.match(publish, /github.actor == 'davidbasilefilho' && github.triggering_actor == 'davidbasilefilho'/);
  assert.match(publish, /github.event_name == 'push' && github.ref == 'refs\/tags\/v0.17.0'/);
  assert.match(publish, /publication-authorization.cjs[\s\S]*source-gate.cjs[\s\S]*node npm\/packager\/publish.cjs/);
  assert.match(publish, /environment: holycodex-publish/);
});
