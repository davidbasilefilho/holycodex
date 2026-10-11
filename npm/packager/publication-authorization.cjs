'use strict';

const assert = require('node:assert/strict');
const { publicationRoute, distributionVersion } = require('./channel.cjs');

const REPOSITORY = 'davidbasilefilho/holycodex';
const RELEASE_OWNER = 'davidbasilefilho';

// GitHub supplies these identities; never take authorization from dispatch inputs.
// This code gate supplements protected refs, environment approval and npm's
// trusted-publisher binding. It cannot protect a workflow rewritten on its ref.
function authorizePublication(env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, 'publication requires the canonical repository');
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `${REPOSITORY}/.github/workflows/publish.yml@${env.GITHUB_REF}`,
    'publication requires the selected publisher workflow');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'invalid publication source SHA');
  assert.equal(env.GITHUB_WORKFLOW_SHA, env.GITHUB_SHA, 'publisher and source must have the same SHA');
  assert.ok(['true', 'false'].includes(env.PUBLISH_DEV), 'DEV approval must be an explicit boolean');
  const route = publicationRoute(env.GITHUB_EVENT_NAME, env.GITHUB_REF, env.PUBLISH_DEV === 'true');
  if (route.publish) {
    assert.equal(env.GITHUB_ACTOR, RELEASE_OWNER, 'only the release owner may initiate publication');
    assert.equal(env.GITHUB_TRIGGERING_ACTOR, RELEASE_OWNER, 'only the release owner may rerun publication');
  }
  return { ...route, version: distributionVersion(route.channel, env.GITHUB_RUN_ID) };
}

if (require.main === module) {
  const route = authorizePublication(process.env);
  console.log(`channel=${route.channel}\npublish=${route.publish}\nversion=${route.version}`);
}

module.exports = { authorizePublication };
