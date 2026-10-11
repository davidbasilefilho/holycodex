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
const { publishPackages, READBACK_TIMEOUT_MS, POLL_DELAYS_MS } = require('./publish.cjs');
const { publishGithubRelease } = require('./github-release.cjs');
const { verifySelectedRef } = require('./source-gate.cjs');
const SHA = 'a'.repeat(40);

// Distribution and publication fixtures; these bytes are not runtime evidence.
function fixture(t, channel = 'dev', nativeBytes = Buffer.from('native distribution fixture, not executable')) {
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
      const bytes = nativeBytes;
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
  const events = [];
  const waits = [];
  const adapter = {
    read: async (name) => {
      events.push({ operation: 'read', name });
      return packages.get(name);
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
    publish: async (archive, tag) => {
      const name = [...f.archives].find(([, file]) => file === archive)[0];
      calls.push({ name, tag });
      events.push({ operation: 'publish', name });
      const metadata = packages.get(name);
      metadata.versions[f.version] = { dist: { integrity: `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}` } };
      metadata['dist-tags'][tag] = f.version;
    },
  };
  return { packages, calls, events, waits, adapter };
}

function receiptJournal(f, state = 'accepted') {
  const name = PLATFORM_PACKAGES[0];
  return {
    format: 1, sourceSha: SHA, version: f.version, tag: 'dev', runId: 'local', runAttempt: 1,
    receipts: [{ name, state, latest: 'old-stable', integrity: `sha512-${createHash('sha512').update(fs.readFileSync(f.archives.get(name))).digest('base64')}` }],
  };
}

function saveJournal(f, journal) {
  const filename = path.join(path.dirname(f.artifacts), 'publication-journal.json');
  fs.writeFileSync(filename, typeof journal === 'string' ? journal : JSON.stringify(journal));
  return filename;
}

test('accepted npm writes tolerate delayed 404 and stale versions beyond six reads', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  const read = r.adapter.read;
  const publish = r.adapter.publish;
  const pending = PLATFORM_PACKAGES[2];
  let delayedReads = 0;
  r.adapter.publish = async (archive, tag) => {
    const name = [...f.archives].find(([, filename]) => filename === archive)[0];
    const journal = JSON.parse(fs.readFileSync(path.join(path.dirname(f.artifacts), 'publication-journal.json')));
    assert.equal(journal.receipts.find((receipt) => receipt.name === name).state, 'attempted',
      'attempt is durable before npm is called');
    await publish(archive, tag);
  };
  r.adapter.read = async (name) => {
    const metadata = await read(name);
    if (name !== pending || !metadata.versions[f.version]) return metadata;
    const journal = JSON.parse(fs.readFileSync(path.join(path.dirname(f.artifacts), 'publication-journal.json')));
    assert.equal(journal.receipts.find((receipt) => receipt.name === name).state, 'accepted',
      'CLI success is durable before verification');
    delayedReads++;
    if (delayedReads <= 2) return undefined;
    if (delayedReads <= 8) return { ...metadata, versions: {} };
    return metadata;
  };
  const wait = r.adapter.wait;
  r.adapter.wait = async (milliseconds) => {
    assert.equal(r.packages.get('holycodex').versions[f.version], undefined);
    await wait(milliseconds);
  };
  await publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter);
  assert.equal(delayedReads, 9);
  assert.deepEqual(r.calls.map((call) => call.name), [...PLATFORM_PACKAGES, 'holycodex']);
  assert.ok(r.waits.reduce((sum, delay) => sum + delay, 0) > 30000);
  assert.ok(r.waits.reduce((sum, delay) => sum + delay, 0) <= READBACK_TIMEOUT_MS);
});

test('bootstrap metadata 404 can settle before registry preflight permits a new version', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  const read = r.adapter.read;
  let absentReads = 0;
  r.adapter.read = async (name) => {
    const metadata = await read(name);
    if (name === PLATFORM_PACKAGES[0] && ++absentReads <= 3) return undefined;
    return metadata;
  };
  await publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter);
  assert.equal(r.calls.length, 4);
  assert.ok(r.waits.length > 0);
});

test('accepted pending receipt survives a workflow retry and never permits blind republish', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  r.adapter.runId = '123';
  const read = r.adapter.read;
  let visible = false;
  r.adapter.read = async (name) => {
    const metadata = await read(name);
    return name === PLATFORM_PACKAGES[0] && metadata.versions[f.version] && !visible ? undefined : metadata;
  };
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /accepted publication pending verification/);
  assert.equal(r.calls.length, 1);
  const filename = path.join(path.dirname(f.artifacts), 'publication-journal.json');
  const historyRoot = path.join(path.dirname(f.artifacts), 'history');
  const prior = path.join(historyRoot, 'holycodex-publish-journal-123-1');
  fs.mkdirSync(prior, { recursive: true });
  fs.copyFileSync(filename, path.join(prior, 'publication-journal.json'));
  fs.rmSync(filename);
  r.adapter.historyRoot = historyRoot;
  r.adapter.runAttempt = 2;
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /do not republish or select a new version/);
  assert.equal(r.calls.length, 1, 'a restored accepted receipt blocks writes while registry metadata is absent');
  visible = true;
  await publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter);
  assert.deepEqual(r.calls.map((call) => call.name), [...PLATFORM_PACKAGES, 'holycodex']);
  assert.equal(JSON.parse(fs.readFileSync(filename)).runAttempt, 2);
});

test('an ambiguous receipt for a later package blocks every earlier new publication', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  const journal = receiptJournal(f, 'attempted');
  journal.receipts[0] = { name: 'holycodex', state: 'attempted', latest: 'old-stable',
    integrity: `sha512-${createHash('sha512').update(fs.readFileSync(f.archives.get('holycodex'))).digest('base64')}` };
  saveJournal(f, journal);
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /ambiguous/);
  assert.deepEqual(r.calls, []);
  assert.equal(POLL_DELAYS_MS.reduce((sum, delay) => sum + delay, 0), READBACK_TIMEOUT_MS);
});

test('a rerun without the immediately preceding attempt journal fails before registry access', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  const historyRoot = path.join(path.dirname(f.artifacts), 'history');
  const old = path.join(historyRoot, 'holycodex-publish-journal-local-1');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'publication-journal.json'), JSON.stringify(receiptJournal(f)));
  r.adapter.historyRoot = historyRoot;
  r.adapter.runAttempt = 3;
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /previous workflow attempt publication journal is missing/);
  assert.deepEqual(r.events, []);
});

for (const unstarted of ['job', 'step']) {
  test(`verified skipped prior publish ${unstarted} allows the first publication after a build/setup retry`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const proofRoot = path.join(path.dirname(f.artifacts), 'proof');
    fs.mkdirSync(proofRoot);
    const job = { id: 1, run_id: 123, head_sha: SHA, name: 'publish', status: 'completed',
      conclusion: unstarted === 'job' ? 'skipped' : 'failure', steps: unstarted === 'job' ? [] : [
        { name: 'Verify and publish all platforms before the wrapper', status: 'completed', conclusion: 'skipped' },
      ] };
    fs.writeFileSync(path.join(proofRoot, 'attempt-1.json'), JSON.stringify([{ total_count: 1, jobs: [job] }]));
    Object.assign(r.adapter, { runId: '123', runAttempt: 2, historyProofRoot: proofRoot });
    await publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter);
    assert.equal(r.calls.length, 4);
  });
}

for (const invalid of ['executed', 'missing-job', 'missing-step', 'incomplete-pages', 'different-run', 'different-sha']) {
  test(`missing receipt with ${invalid} prior-job proof fails before registry access`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const proofRoot = path.join(path.dirname(f.artifacts), 'proof');
    fs.mkdirSync(proofRoot);
    const job = { id: 1, run_id: 123, head_sha: SHA, name: 'publish', status: 'completed', conclusion: 'failure',
      steps: [{ name: 'Verify and publish all platforms before the wrapper', status: 'completed', conclusion: 'skipped' }] };
    const page = { total_count: 1, jobs: [job] };
    if (invalid === 'executed') job.steps[0].conclusion = 'failure';
    if (invalid === 'missing-job') job.name = 'quality';
    if (invalid === 'missing-step') job.steps = [];
    if (invalid === 'incomplete-pages') page.total_count = 2;
    if (invalid === 'different-run') job.run_id++;
    if (invalid === 'different-sha') job.head_sha = 'b'.repeat(40);
    fs.writeFileSync(path.join(proofRoot, 'attempt-1.json'), JSON.stringify([page]));
    Object.assign(r.adapter, { runId: '123', runAttempt: 2, historyProofRoot: proofRoot });
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter));
    assert.deepEqual(r.events, []);
  });
}

for (const baseline of ['old-stable', null]) {
  test(`DEV retry preserves original latest baseline ${baseline} after an accepted write and lost readback`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const name = PLATFORM_PACKAGES[0];
    if (baseline === null) delete r.packages.get(name)['dist-tags'].latest;
    const read = r.adapter.read;
    const publish = r.adapter.publish;
    r.adapter.publish = async (...args) => {
      await publish(...args);
      r.packages.get(name)['dist-tags'].latest = f.version;
    };
    r.adapter.read = async (packageName) => {
      const metadata = await read(packageName);
      return packageName === name && r.calls.length ? undefined : metadata;
    };
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /accepted publication pending verification/);
    const filename = path.join(path.dirname(f.artifacts), 'publication-journal.json');
    assert.equal(JSON.parse(fs.readFileSync(filename)).receipts[0].latest, baseline);
    r.adapter.read = read;
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /DEV unexpectedly changed latest/);
    assert.equal(r.calls.length, 1, 'the changed tag is never adopted as a fresh baseline');
  });
}

for (const corruption of ['json', 'sourceSha', 'version', 'tag', 'runId', 'runAttempt', 'integrity', 'state', 'duplicate', 'latest']) {
  test(`corrupt or conflicting journal ${corruption} fails before registry reads or writes`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const journal = receiptJournal(f);
    if (corruption === 'latest') delete journal.receipts[0].latest;
    else if (['integrity', 'state'].includes(corruption)) journal.receipts[0][corruption] = 'wrong';
    else if (corruption === 'duplicate') journal.receipts.push(journal.receipts[0]);
    else journal[corruption] = 'wrong';
    saveJournal(f, corruption === 'json' ? '{broken' : journal);
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter));
    assert.deepEqual(r.events, []);
  });
}

test('distribution versions separate stable from immutable run-specific DEV', () => {
  assert.equal(distributionVersion('dev', '123'), '0.17.0-dev.123');
  assert.equal(distributionVersion('stable', '123'), BASE_VERSION);
  assert.equal(distributionVersion('dev', '123', ''), '0.17.0-dev.123');
  assert.equal(distributionVersion('dev', '123', '0.17.0-dev.123'), '0.17.0-dev.123');
  for (const args of [['dev', '123', '0.17.0-dev.456'], ['dev', '123', '0.17.0-1.dev.123'], ['dev', '123', BASE_VERSION], ['stable', '123', '0.17.0-dev.123'], ['latest', '123'], ['dev', '../bad']]) {
    assert.throws(() => distributionVersion(...args));
  }
});

test('npm semver excludes DEV from stable ranges but preserves explicit legacy prerelease opt-in', () => {
  // Use npm's own resolver, without adding a runtime dependency to the wrapper.
  const npmPath = process.env.npm_execpath;
  assert.ok(npmPath && path.isAbsolute(npmPath) && fs.existsSync(npmPath),
    'Run these tests through npm exec --offline --call "node --test ..." to select the npm CLI');
  const npmRoot = path.resolve(path.dirname(fs.realpathSync(npmPath)), '..');
  assert.equal(JSON.parse(fs.readFileSync(path.join(npmRoot, 'package.json'))).name, 'npm');
  const semver = require(path.join(npmRoot, 'node_modules', 'semver'));
  const dev = distributionVersion('dev', '123');
  for (const range of ['^0.17.0', '~0.17.0', '>=0.17.0 <0.18.0', '0.17.x', '*']) {
    assert.equal(semver.satisfies(BASE_VERSION, range), true, range);
    assert.equal(semver.satisfies(dev, range), false, range);
  }
  assert.equal(semver.satisfies(dev, '^0.17.0-1'), true);
});

for (const channel of ['dev', 'stable']) {
  test(`${channel} publishes platforms before wrapper with exact consistent versions/tag`, async (t) => {
    const f = fixture(t, channel);
    verifyRelease(f.artifacts, SHA, f.version);
    const r = registry(f);
    await publishPackages(f.artifacts, SHA, f.version, channel, r.adapter);
    assert.deepEqual(r.events.slice(0, 4), [...PLATFORM_PACKAGES, 'holycodex']
      .map((name) => ({ operation: 'read', name })), 'preflight every package before the first registry write');
    assert.deepEqual(r.events.slice(4), [...PLATFORM_PACKAGES, 'holycodex'].flatMap((name) => [
      { operation: 'publish', name }, { operation: 'read', name },
    ]), 'each native publication is read back before advancing toward the wrapper');
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

for (const name of [...PLATFORM_PACKAGES, 'holycodex']) {
  test(`missing ${name} artifact prevents the first registry read or write`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    fs.rmSync(path.dirname(f.archives.get(name)), { recursive: true });
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter),
      /expected wrapper and three platform artifacts/);
    assert.deepEqual(r.events, []);
  });

  test(`corrupt ${name} metadata prevents the first registry read or write`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const stage = path.join(path.dirname(f.artifacts), name.replace('@turndev/', ''), 'package');
    const filename = path.join(stage, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(filename, 'utf8'));
    metadata.version = '0.17.0-dev.999';
    fs.writeFileSync(filename, JSON.stringify(metadata));
    execFileSync('tar', ['-czf', f.archives.get(name), '-C', path.dirname(stage), 'package']);
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /package version mismatch/);
    assert.deepEqual(r.events, []);
  });
}

for (const name of PLATFORM_PACKAGES) {
  test(`${name} payload version drift prevents the first registry read or write`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const stage = path.join(path.dirname(f.artifacts), name.replace('@turndev/', ''), 'package');
    const filename = path.join(stage, 'payload.toml');
    fs.writeFileSync(filename, fs.readFileSync(filename, 'utf8').replace(f.version, '0.17.0-dev.999'));
    execFileSync('tar', ['-czf', f.archives.get(name), '-C', path.dirname(stage), 'package']);
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter));
    assert.deepEqual(r.events, []);
  });

  test(`wrapper dependency version drift for ${name} prevents the first registry read or write`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const stage = path.join(path.dirname(f.artifacts), 'holycodex', 'package');
    const filename = path.join(stage, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(filename));
    metadata.optionalDependencies[name] = '0.17.0-dev.999';
    fs.writeFileSync(filename, JSON.stringify(metadata));
    execFileSync('tar', ['-czf', f.archives.get('holycodex'), '-C', path.dirname(stage), 'package']);
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter));
    assert.deepEqual(r.events, []);
  });
}

test('corrupt last native payload prevents the first registry read or write', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  const name = PLATFORM_PACKAGES[2];
  const stage = path.join(path.dirname(f.artifacts), name.replace('@turndev/', ''), 'package');
  for (const alias of ['holycodex.exe', 'codex.exe']) fs.writeFileSync(path.join(stage, 'bin', alias), 'corrupt payload');
  execFileSync('tar', ['-czf', f.archives.get(name), '-C', path.dirname(stage), 'package']);
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /payload digest mismatch/);
  assert.deepEqual(r.events, []);
});

for (const channel of ['dev', 'stable']) {
  for (const persistedBeforeFailure of [false, true]) {
    test(`${channel} ${persistedBeforeFailure ? 'verifies a lost publish response' : 'withholds an ambiguous failed publish'} without duplicate versions`, async (t) => {
      const f = fixture(t, channel);
      const r = registry(f);
      const publish = r.adapter.publish;
      const interruptedArchive = f.archives.get(PLATFORM_PACKAGES[2]);
      r.adapter.publish = async (archive, tag) => {
        if (archive !== interruptedArchive || persistedBeforeFailure) await publish(archive, tag);
        if (archive === interruptedArchive) throw new Error('interrupted npm publish');
      };
      if (persistedBeforeFailure) {
        await publishPackages(f.artifacts, SHA, f.version, channel, r.adapter);
        assert.deepEqual(r.calls.map((call) => call.name), [...PLATFORM_PACKAGES, 'holycodex']);
      } else {
        await assert.rejects(publishPackages(f.artifacts, SHA, f.version, channel, r.adapter), /ambiguous/);
        assert.deepEqual(r.calls.map((call) => call.name), PLATFORM_PACKAGES.slice(0, 2));
        assert.equal(r.packages.get('holycodex').versions[f.version], undefined, 'the wrapper is withheld after partial publication');
      }
      r.adapter.publish = publish;
      const beforeRetry = r.calls.slice();
      if (persistedBeforeFailure) await publishPackages(f.artifacts, SHA, f.version, channel, r.adapter);
      else await assert.rejects(publishPackages(f.artifacts, SHA, f.version, channel, r.adapter), /do not republish/);
      assert.deepEqual(r.calls, beforeRetry, 'a retry must never repeat an accepted or ambiguous attempt');
    });
  }
}

test('release verification supports native payloads larger than child-process default buffer', (t) => {
  // Large distribution fixture only; not a runtime executable or acceptance proof.
  const f = fixture(t, 'dev', Buffer.alloc(2 * 1024 * 1024, 0x5a));
  verifyRelease(f.artifacts, SHA, f.version);
});

test('large native verification still rejects alias differences and matching corrupt aliases', (t) => {
  const f = fixture(t, 'dev', Buffer.alloc(2 * 1024 * 1024, 0x5a));
  const name = PLATFORM_PACKAGES[0];
  const stage = path.join(path.dirname(f.artifacts), name.replace('@turndev/', ''), 'package');
  const altered = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  altered[altered.length - 1] = 0x59;
  const repack = () => execFileSync('tar', ['-czf', f.archives.get(name), '-C', path.dirname(stage), 'package']);
  fs.writeFileSync(path.join(stage, 'bin', 'codex'), altered);
  repack();
  assert.throws(() => verifyRelease(f.artifacts, SHA, f.version), /executable aliases differ/);
  fs.writeFileSync(path.join(stage, 'bin', 'holycodex'), altered);
  repack();
  assert.throws(() => verifyRelease(f.artifacts, SHA, f.version), /payload digest mismatch/);
});

test('absent platform bootstrap or wrapper prevents all automated publication', async (t) => {
  for (const missing of [PLATFORM_PACKAGES[2], 'holycodex']) {
    const f = fixture(t);
    const r = registry(f);
    r.packages.delete(missing);
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /bootstrap/);
    assert.deepEqual(r.calls, []);
  }
});

for (const name of PLATFORM_PACKAGES) {
  test(`failed ${name} registry readback withholds wrapper`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const publish = r.adapter.publish;
    r.adapter.publish = async (archive, tag) => {
      await publish(archive, tag);
      if (archive === f.archives.get(name)) delete r.packages.get(name).versions[f.version];
    };
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /readback failed/);
    assert.deepEqual(r.calls.map((call) => call.name), PLATFORM_PACKAGES.slice(0, PLATFORM_PACKAGES.indexOf(name) + 1));
    assert.ok(r.events.filter((event) => event.operation === 'read' && event.name === name).length > 7,
      'bounded backoff must tolerate more than the previous six readback attempts');
    assert.ok(r.waits.reduce((sum, delay) => sum + delay, 0) <= READBACK_TIMEOUT_MS);
    assert.equal(r.packages.get('holycodex').versions[f.version], undefined);
  });
}

test('failed wrapper readback reports possible publication and an exact retry does not republish', async (t) => {
  const f = fixture(t);
  const r = registry(f);
  const read = r.adapter.read;
  r.adapter.read = async (name) => {
    const metadata = await read(name);
    if (name === 'holycodex' && r.calls.length === 4) return { ...metadata, versions: {} };
    return metadata;
  };
  await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /wrapper may already be published/);
  assert.deepEqual(r.calls.map((call) => call.name), [...PLATFORM_PACKAGES, 'holycodex']);
  assert.ok(r.packages.get('holycodex').versions[f.version], 'npm publication cannot be rolled back by a failed readback');
  r.adapter.read = read;
  r.calls.length = 0;
  await publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter);
  assert.deepEqual(r.calls, []);
});

for (const name of [...PLATFORM_PACKAGES, 'holycodex']) {
  test(`pre-existing conflicting ${name} integrity aborts before writing any package`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    r.packages.get(name).versions[f.version] = { dist: { integrity: 'wrong' } };
    await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /differs/);
    assert.deepEqual(r.calls, []);
  });

  for (const channel of ['dev', 'stable']) {
    test(`pre-existing identical ${name} without the ${channel === 'dev' ? 'dev' : 'latest'} tag aborts before writing any package`, async (t) => {
      const f = fixture(t, channel);
      const r = registry(f);
      const metadata = r.packages.get(name);
      metadata.versions[f.version] = { dist: {
        integrity: `sha512-${createHash('sha512').update(fs.readFileSync(f.archives.get(name))).digest('base64')}`,
      } };
      await assert.rejects(publishPackages(f.artifacts, SHA, f.version, channel, r.adapter), /owner must reconcile the dist-tag/);
      assert.deepEqual(r.calls, []);
    });
  }
}

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
    assert.equal(body.make_latest, f.version === BASE_VERSION ? 'true' : 'false');
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

test('release review pushes validate but only explicit accepted DEV dispatches publish', () => {
  assert.deepEqual(publicationRoute('push', 'refs/heads/release/v0.17.0/release-routing'), { channel: 'dev', publish: false });
  assert.deepEqual(publicationRoute('workflow_dispatch', 'refs/heads/release/v0.17.0/release-routing', true), { channel: 'dev', publish: true });
  assert.deepEqual(publicationRoute('push', 'refs/tags/v0.17.0'), { channel: 'stable', publish: true });
  assert.throws(() => publicationRoute('push', 'refs/tags/v0.17.0-1'), /accepted release tag/);
  for (const request of [undefined, false]) {
    assert.throws(() => publicationRoute('workflow_dispatch', 'refs/heads/release/v0.17.0/release-routing', request), /explicit publication approval/);
  }
  assert.throws(() => publicationRoute('workflow_dispatch', 'refs/heads/release/v0.17.0/release-routing', 'true'), /approval must be explicit/);
  assert.throws(() => publicationRoute('push', 'refs/heads/release/v0.17.0/release-routing', true), /manual dispatch/);
  for (const ref of ['refs/heads/next', 'refs/heads/release/v0.18.0', 'refs/heads/codex/dev-publishing-entry', 'refs/tags/v0.17.0']) {
    assert.throws(() => publicationRoute('workflow_dispatch', ref, true), /accepted release branch/);
    assert.throws(() => publicationRoute('pull_request', ref), /unsupported publication event/);
  }
  for (const ref of ['refs/heads/next', 'refs/heads/release/v0.18.0', 'refs/heads/codex/native-validation/reviewed']) {
    assert.throws(() => publicationRoute('push', ref));
  }
});

test('OIDC publisher and branch-selected validator use separate workflow identities', () => {
  const workflows = path.join(__dirname, '..', '..', '.github', 'workflows');
  const publisher = fs.readFileSync(path.join(workflows, 'publish.yml'), 'utf8');
  const validator = fs.readFileSync(path.join(workflows, 'native-validation.yml'), 'utf8');
  assert.match(publisher, /workflow_dispatch:/);
  assert.match(publisher, /publish_dev:[\s\S]*type: boolean[\s\S]*default: false/);
  assert.match(publisher, /branches: \["release\/v0\.17\.0\/release-routing"\]/);
  assert.match(publisher, /environment: holycodex-publish/);
  assert.match(publisher, /github.event_name == 'workflow_dispatch' && inputs\.publish_dev == true/);
  assert.match(publisher, /github\.ref == 'refs\/heads\/release\/v0\.17\.0\/release-routing'/);
  assert.match(validator, /codex\/native-validation\/\*\*/);
  for (const name of ['native-validation.yml', 'release.yml', 'dev.yml', 'stable.yml']) {
    const text = fs.readFileSync(path.join(workflows, name), 'utf8');
    assert.doesNotMatch(text, /id-token|contents: write|npm publish|github-release\.cjs/);
  }
});

test('publication waits for selected full validation and serializes DEV/stable registry access', () => {
  const publisher = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'publish.yml'), 'utf8');
  const publishJob = publisher.slice(publisher.indexOf('\n  publish:\n'));
  assert.match(publishJob, /needs: \[route, dev, stable\]/);
  assert.match(publishJob, /needs\.route\.result == 'success'/);
  assert.match(publishJob, /needs\.route\.outputs\.channel == 'dev' && needs\.dev\.result == 'success'/);
  assert.match(publishJob, /needs\.route\.outputs\.channel == 'stable' && needs\.stable\.result == 'success'/);
  assert.match(publishJob, /\n    concurrency:\n      group: holycodex-registry-publication\n      cancel-in-progress: false\n/);
  assert.match(publishJob, /source-gate\.cjs[\s\S]*node npm\/packager\/publish\.cjs/,
    'source identity is rechecked after acquiring the publication lock');
  assert.match(publishJob, /pattern: holycodex-publish-journal-\$\{\{ github\.run_id \}\}-\*/);
  assert.match(publishJob, /gh api --paginate --slurp.*\/attempts\/\$attempt\/jobs\?per_page=100/);
  assert.match(publishJob, /id: publication_receipts\n        if: always\(\)/);
  assert.match(publishJob, /name: holycodex-publish-journal-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(publishJob, /if-no-files-found: error/);
  assert.match(publishJob, /Do not republish or change versions/);
});

test('remote source gate accepts the release branch and lightweight/annotated release commit identity', () => {
  verifySelectedRef(`${SHA}\trefs/heads/release/v0.17.0/release-routing\n`, 'refs/heads/release/v0.17.0/release-routing', SHA);
  verifySelectedRef(`${SHA}\trefs/tags/v0.17.0\n`, 'refs/tags/v0.17.0', SHA);
  verifySelectedRef(`${'b'.repeat(40)}\trefs/tags/v0.17.0\n${SHA}\trefs/tags/v0.17.0^{}\n`, 'refs/tags/v0.17.0', SHA);
});

test('remote tag removed or moved during validation cannot pass publication gate', () => {
  assert.throws(() => verifySelectedRef('', 'refs/tags/v0.17.0', SHA), /missing/);
  assert.throws(() => verifySelectedRef(`${'b'.repeat(40)}\trefs/tags/v0.17.0\n`, 'refs/tags/v0.17.0', SHA), /moved/);
  assert.throws(() => verifySelectedRef(`${SHA}\trefs/tags/v0.17.0\n${'b'.repeat(40)}\trefs/tags/v0.17.0^{}\n`, 'refs/tags/v0.17.0', SHA), /moved/);
  assert.throws(() => verifySelectedRef(`${'b'.repeat(40)}\trefs/heads/release/v0.17.0/release-routing\n`, 'refs/heads/release/v0.17.0/release-routing', SHA), /moved/);
});

test('stable release helper cannot recreate a removed accepted tag', async (t) => {
  const f = fixture(t, 'stable');
  const writes = [];
  const missingTag = async (method, resource) => {
    if (method !== 'GET') writes.push(resource);
    return undefined;
  };
  await assert.rejects(publishGithubRelease(f.artifacts, SHA, f.version, 'stable', missingTag), /stable tag is missing/);
  assert.deepEqual(writes, []);
});

test('stable GitHub release uses existing accepted tag and latest metadata', async (t) => {
  const f = fixture(t, 'stable');
  const api = releaseApi(f);
  await publishGithubRelease(f.artifacts, SHA, f.version, 'stable', api.request);
  assert.equal(api.release.prerelease, false);
  assert.equal(api.release.make_latest, 'true');
  assert.equal(api.uploads.length, 4);
});

for (const outcome of ['visible', 'delayed-response', 'transport-error', 'overslept', 'late-response']) {
  test(`final bounded readback ${outcome} preserves deadline and publication journal`, async (t) => {
    const f = fixture(t);
    const r = registry(f);
    const pending = PLATFORM_PACKAGES[0];
    const read = r.adapter.read;
    let clock = 0;
    const confirmationReads = [];
    const finalReadAt = 286250;
    const finalReadBudget = READBACK_TIMEOUT_MS - finalReadAt;
    r.adapter.now = () => clock;
    r.adapter.wait = async (delay) => {
      r.waits.push(delay);
      clock += delay;
      if (outcome === 'overslept' && clock === finalReadAt) clock = READBACK_TIMEOUT_MS + 1;
    };
    r.adapter.read = async (name, timeout) => {
      const metadata = await read(name);
      if (name !== pending || !metadata.versions[f.version]) return metadata;
      confirmationReads.push({ at: clock, timeout });
      assert.ok(clock + timeout <= READBACK_TIMEOUT_MS, 'reads remain within the deadline');
      if (clock < finalReadAt) return { ...metadata, versions: {} };
      if (outcome === 'transport-error') throw new Error('registry transport unavailable');
      if (outcome === 'delayed-response') {
        assert.ok(timeout >= 1000, 'final read permits a realistic response latency');
        clock += 1000;
      }
      if (outcome === 'late-response') clock += timeout + 1;
      return metadata;
    };
    if (outcome === 'visible' || outcome === 'delayed-response') {
      await publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter);
      assert.deepEqual(r.calls.map(({ name }) => name), [...PLATFORM_PACKAGES, 'holycodex']);
    } else {
      await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /do not republish/);
      assert.deepEqual(r.calls.map(({ name }) => name), [pending]);
      const journalPath = path.join(path.dirname(f.artifacts), 'publication-journal.json');
      const journal = JSON.parse(fs.readFileSync(journalPath));
      assert.equal(journal.receipts[0].state, 'accepted');
      assert.ok([...f.archives.values()].every((file) => fs.existsSync(file)));
      // An ambiguous verification retry cannot initiate another npm write.
      r.adapter.read = async () => { throw new Error('registry still unavailable'); };
      await assert.rejects(publishPackages(f.artifacts, SHA, f.version, 'dev', r.adapter), /registry still unavailable/);
      assert.equal(r.calls.length, 1);
      assert.deepEqual(JSON.parse(fs.readFileSync(journalPath)).receipts, journal.receipts);
    }
    assert.equal(confirmationReads.length, POLL_DELAYS_MS.length + (outcome === 'overslept' ? 0 : 1));
    if (outcome !== 'overslept') assert.deepEqual(confirmationReads.at(-1), { at: finalReadAt, timeout: finalReadBudget });
    assert.equal(r.waits.reduce((sum, delay) => sum + delay, 0), finalReadAt);
  });
}
