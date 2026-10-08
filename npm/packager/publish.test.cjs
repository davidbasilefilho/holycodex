'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { BASE_VERSION, PLATFORM_PACKAGES, distributionVersion, stageChannel, tarballName, publicationRoute } = require('./channel.cjs');
const { verifyRelease } = require('./verify-release.cjs');
const { publishPackages } = require('./publish.cjs');
const { publishGithubRelease } = require('./github-release.cjs');
const SHA = 'a'.repeat(40);

// Distribution and transaction fixtures; these bytes are not runtime evidence.
function fixture(t, channel = 'dev') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = distributionVersion(channel, '123');
  const artifacts = path.join(root, 'artifacts');
  fs.mkdirSync(artifacts);
  const archives = new Map();
  for (const name of [...PLATFORM_PACKAGES, 'holycodex']) {
    const localName = name.replace('@turndev/', '');
    const stage = path.join(root, localName, 'package');
    fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
    const template = path.join(__dirname, '..', localName);
    fs.copyFileSync(path.join(template, 'package.json'), path.join(stage, 'package.json'));
    for (const notice of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md']) {
      fs.copyFileSync(path.join(__dirname, '..', '..', notice), path.join(stage, notice));
    }
    if (name === 'holycodex') {
      fs.copyFileSync(path.join(template, 'install.cjs'), path.join(stage, 'install.cjs'));
      for (const alias of ['holycodex.exe', 'codex.exe']) fs.writeFileSync(path.join(stage, 'bin', alias), '');
    } else {
      const bytes = Buffer.from('native distribution fixture, not executable');
      const extension = name.endsWith('win32-x64') ? '.exe' : '';
      for (const alias of ['holycodex', 'codex']) fs.writeFileSync(path.join(stage, 'bin', alias + extension), bytes);
      fs.writeFileSync(path.join(stage, 'payload.toml'), `format = 1\npackage = "${name}"\nversion = "${BASE_VERSION}"\nsha256 = "${createHash('sha256').update(bytes).digest('hex')}"\n`);
    }
    stageChannel(stage, version, channel);
    const directory = path.join(artifacts, localName);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'source-revision.toml'), `source_sha = "${SHA}"\n`);
    const archive = path.join(directory, tarballName(name, version));
    execFileSync('tar', ['-czf', archive, '-C', path.dirname(stage), 'package']);
    archives.set(name, archive);
  }
  return { artifacts, version, archives };
}

function registry(f) {
  const packages = new Map([...f.archives.keys()].map((name) => [name,
    { name, 'dist-tags': { latest: 'old-stable' }, versions: {} }]));
  const calls = [];
  const adapter = {
    read: async (name) => packages.get(name),
    wait: async () => {},
    publish: async (archive, tag) => {
      const name = [...f.archives].find(([, file]) => file === archive)[0];
      calls.push({ name, tag });
      const metadata = packages.get(name);
      metadata.versions[f.version] = { dist: { integrity: `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}` } };
      metadata['dist-tags'][tag] = f.version;
    },
  };
  return { packages, calls, adapter };
}

test('distribution versions separate stable from immutable run-specific DEV', () => {
  assert.equal(distributionVersion('dev', '123'), '0.17.0-1.dev.123');
  assert.equal(distributionVersion('stable', '123'), BASE_VERSION);
  for (const args of [['dev', '123', BASE_VERSION], ['stable', '123', '0.17.0-1.dev.123'], ['latest', '123'], ['dev', '../bad']]) {
    assert.throws(() => distributionVersion(...args));
  }
});

for (const channel of ['dev', 'stable']) {
  test(`${channel} publishes platforms before wrapper with exact consistent versions/tag`, async (t) => {
    const f = fixture(t, channel);
    verifyRelease(f.artifacts, SHA, f.version);
    const r = registry(f);
    await publishPackages(f.artifacts, SHA, f.version, channel, r.adapter);
    assert.deepEqual(r.calls.map((x) => x.name), [...PLATFORM_PACKAGES, 'holycodex']);
    assert.deepEqual(r.calls.map((x) => x.tag), Array(4).fill(channel === 'dev' ? 'dev' : 'latest'));
    for (const metadata of r.packages.values()) {
      assert.equal(metadata['dist-tags'][channel === 'dev' ? 'dev' : 'latest'], f.version);
      if (channel === 'dev') assert.equal(metadata['dist-tags'].latest, 'old-stable');
    }
    r.calls.length = 0;
    await publishPackages(f.artifacts, SHA, f.version, channel, r.adapter);
    assert.deepEqual(r.calls, [], 'identical registry readbacks make retry idempotent');
  });
}

test('absent platform bootstrap or wrapper prevents all automated publication', async (t) => {
  for (const missing of [PLATFORM_PACKAGES[2], 'holycodex']) {
    const f = fixture(t);
    const r = registry(f);
    r.packages.delete(missing);
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /bootstrap/);
    assert.deepEqual(r.calls, []);
  }
});

test('failed native registry readback withholds wrapper', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  r.adapter.publish = async (archive, tag) => { r.calls.push({ archive, tag }); };
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /readback failed/);
  assert.equal(r.calls.length, 1);
  assert.notEqual(r.calls[0].archive, f.archives.get('holycodex'));
});

test('pre-existing conflicting integrity aborts before writing any package', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  r.packages.get('holycodex').versions[f.version] = { dist: { integrity: 'wrong' } };
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /differs/);
  assert.deepEqual(r.calls, []);
});

test('DEV detects unintended latest movement and withholds wrapper', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  const publish = r.adapter.publish;
  r.adapter.publish = async (...args) => {
    await publish(...args);
    r.packages.get(PLATFORM_PACKAGES[0])['dist-tags'].latest = f.version;
  };
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /changed latest/);
  assert.equal(r.calls.length, 1);
});

test('foreign source SHA or wrong channel rejects artifacts before registry access', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  r.adapter.read = async () => { throw new Error('registry must not be called'); };
  await assert.rejects(publishPackages(f.artifacts, 'b'.repeat(40), f.version, 'dev', r.adapter), /source SHA differs/);
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'stable', r.adapter), /selected channel/);
});

function releaseApi(f) {
  let release;
  const uploads = [];
  const request = async (method, resource, body) => {
    if (resource.endsWith('/releases/latest')) return { id: 1 };
    if (resource.includes('/commits/')) return { sha: SHA };
    if (method === 'GET') return release;
    if (resource.startsWith('https://uploads.github.com/')) {
      const asset = { name: new URL(resource).searchParams.get('name'), size: body.length,
        state: 'uploaded', digest: `sha256:${createHash('sha256').update(body).digest('hex')}` };
      release.assets.push(asset);
      uploads.push(asset.name);
      return asset;
    }
    assert.equal(body.make_latest, 'false');
    release = { ...body, id: 2, assets: [], upload_url: 'https://uploads.github.com/repos/davidbasilefilho/holycodex/releases/2/assets{?name,label}' };
    return release;
  };
  return { request, uploads, get release() { return release; } };
}

test('interrupted GitHub asset publication resumes missing assets without replacements', async (t) => {
  const f = fixture(t);
  const api = releaseApi(f);
  let failed = false;
  const interrupted = async (...args) => {
    if (!failed && api.uploads.length === 1 && args[1].startsWith('https://uploads.github.com/')) {
      failed = true;
      throw new Error('interrupted upload');
    }
    return api.request(...args);
  };
  await assert.rejects(publishGithubRelease(f.artifacts, SHA, f.version, 'dev', interrupted), /interrupted/);
  assert.equal(api.uploads.length, 1);
  await publishGithubRelease(f.artifacts, SHA, f.version, 'dev', api.request);
  assert.equal(api.uploads.length, 4);
  assert.equal(new Set(api.uploads).size, 4);
  await publishGithubRelease(f.artifacts, SHA, f.version, 'dev', api.request);
  assert.equal(api.uploads.length, 4);
});

test('conflicting existing GitHub asset or tag prevents repair writes', async (t) => {
  const f = fixture(t);
  const api = releaseApi(f);
  await publishGithubRelease(f.artifacts, SHA, f.version, 'dev', api.request);
  api.release.assets[0].digest = 'sha256:wrong';
  await assert.rejects(publishGithubRelease(f.artifacts, SHA, f.version, 'dev', api.request), /digest differs/);
  assert.equal(api.uploads.length, 4);
  const foreignTag = async (...args) => args[1].includes('/commits/') ? { sha: 'b'.repeat(40) } : api.request(...args);
  await assert.rejects(publishGithubRelease(f.artifacts, SHA, f.version, 'dev', foreignTag), /different source/);
  assert.equal(api.uploads.length, 4);
});

test('validation-only feature dispatch builds DEV without publishing; ordinary feature/stable dispatch rejected', () => {
  assert.deepEqual(publicationRoute('workflow_dispatch', 'refs/heads/codex/dev-publishing-entry', 'true'), { channel: 'dev', publish: false });
  assert.deepEqual(publicationRoute('workflow_dispatch', 'refs/heads/next', 'true'), { channel: 'dev', publish: false });
  assert.deepEqual(publicationRoute('workflow_dispatch', 'refs/heads/next', 'false'), { channel: 'dev', publish: true });
  assert.deepEqual(publicationRoute('push', 'refs/heads/next'), { channel: 'dev', publish: true });
  assert.deepEqual(publicationRoute('push', 'refs/tags/v0.17.0-1'), { channel: 'stable', publish: true });
  for (const args of [['workflow_dispatch', 'refs/heads/codex/dev-publishing-entry', 'false'], ['workflow_dispatch', 'refs/tags/v0.17.0-1', 'false'], ['workflow_dispatch', 'refs/tags/v0.17.0-1', 'true'], ['pull_request', 'refs/heads/next'], ['workflow_dispatch', 'refs/heads/next', 'unknown']]) {
    assert.throws(() => publicationRoute(...args));
  }
});
