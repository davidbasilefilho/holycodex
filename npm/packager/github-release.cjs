'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateVersion, tarballName, PLATFORM_PACKAGES } = require('./channel.cjs');
const { verifyRelease } = require('./verify-release.cjs');

async function githubRequest(method, resource, body, binary = false) {
  assert.ok(process.env.GH_TOKEN, 'GitHub release token missing');
  const response = await fetch(resource.startsWith('https://uploads.github.com/')
    ? resource : `https://api.github.com/${resource}`, {
    method,
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': binary ? 'application/octet-stream' : 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: body === undefined ? undefined : binary ? body : JSON.stringify(body),
  });
  if (response.status === 404 && method === 'GET') return undefined;
  assert.ok(response.ok, `GitHub ${method} failed: HTTP ${response.status}`);
  return response.json();
}

// Repair missing uploads after an interrupted create; never replace a conflicting
// existing asset or retarget an existing tag/release to another source.
async function publishGithubRelease(root, sha, version, channel, request = githubRequest) {
  validateVersion(version, channel);
  verifyRelease(root, sha, version);
  const repository = 'davidbasilefilho/holycodex';
  const tag = `v${version}`;
  const prefix = `repos/${repository}`;
  let release = await request('GET', `${prefix}/releases/tags/${tag}`);
  if (!release) {
    const existingTag = await request('GET', `${prefix}/commits/${tag}`);
    if (channel === 'stable') assert.ok(existingTag, 'accepted stable tag is missing');
    assert.ok(!existingTag || existingTag.sha === sha, 'existing tag points to a different source');
    release = await request('POST', `${prefix}/releases`, {
      tag_name: tag, target_commitish: sha, name: `HolyCodex ${version}`,
      prerelease: channel === 'dev', draft: false,
      make_latest: channel === 'dev' ? 'false' : 'true',
      body: `Source: ${sha}\n\nDistribution: ${version}; runtime base: 0.17.0-1.\n\nInstall: npm install --global holycodex@${version}`,
    });
  }
  assert.equal(release.tag_name, tag);
  assert.equal(release.prerelease, channel === 'dev', 'existing release channel differs');
  assert.equal(release.draft, false, 'existing release is draft');
  const commit = await request('GET', `${prefix}/commits/${tag}`);
  assert.equal(commit?.sha, sha, 'existing release tag points to a different source');
  const uploadUrl = new URL(release.upload_url.split('{')[0]);
  assert.equal(uploadUrl.origin, 'https://uploads.github.com');
  assert.equal(uploadUrl.pathname, `/repos/${repository}/releases/${release.id}/assets`);
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  for (const name of [...PLATFORM_PACKAGES, 'holycodex']) {
    const filename = tarballName(name, version);
    const archive = directories.map((directory) => path.join(directory, filename)).find(fs.existsSync);
    const bytes = fs.readFileSync(archive);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const existing = (release.assets || []).filter((asset) => asset.name === filename);
    assert.ok(existing.length <= 1, 'duplicate release asset');
    let asset = existing[0];
    if (!asset) {
      uploadUrl.searchParams.set('name', filename);
      asset = await request('POST', uploadUrl.toString(), bytes, true);
    }
    assert.equal(asset.state, 'uploaded', `${filename}: upload incomplete`);
    assert.equal(asset.size, bytes.length, `${filename}: release asset size differs`);
    assert.equal(asset.digest, digest, `${filename}: release asset digest differs`);
  }
  if (channel === 'dev') {
    const latest = await request('GET', `${prefix}/releases/latest`);
    assert.notEqual(latest?.id, release.id, 'DEV release must not be latest');
  }
}

if (require.main === module) {
  publishGithubRelease(...process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { publishGithubRelease };
