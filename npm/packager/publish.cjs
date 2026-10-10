'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PLATFORM_PACKAGES, validateVersion, tarballName } = require('./channel.cjs');
const { verifyRelease } = require('./verify-release.cjs');

const READBACK_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_DELAYS_MS = [5000, 10000, 20000, ...Array(8).fill(30000), 25000];
const RECEIPT_STATES = ['attempted', 'accepted', 'verified'];
const PUBLISH_STEP_NAME = 'Verify and publish all platforms before the wrapper';

async function registryPackage(name, timeoutMs = 30000) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `registry read failed for ${name}: HTTP ${response.status}`);
  return response.json();
}

function verifyUnstartedAttempt(filename, runId, sha) {
  assert.ok(filename && fs.existsSync(filename),
    'previous workflow attempt publication journal is missing and no skipped-job proof exists; do not republish: owner must reconcile the prior attempt');
  const pages = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.ok(Array.isArray(pages) && pages.length > 0, 'invalid prior-attempt jobs proof');
  const total = pages[0].total_count;
  assert.ok(Number.isSafeInteger(total) && total > 0, 'invalid prior-attempt jobs count');
  for (const page of pages) assert.ok(page.total_count === total && Array.isArray(page.jobs), 'incomplete prior-attempt jobs proof');
  const jobs = pages.flatMap((page) => page.jobs);
  assert.equal(jobs.length, total, 'incomplete prior-attempt jobs pagination');
  assert.equal(new Set(jobs.map((job) => job.id)).size, total, 'duplicate prior-attempt jobs');
  for (const job of jobs) {
    assert.equal(String(job.run_id), runId, 'prior-attempt jobs belong to a different run');
    assert.equal(job.head_sha, sha, 'prior-attempt jobs belong to different source');
    assert.equal(job.status, 'completed', 'prior workflow attempt is not complete');
  }
  const publishers = jobs.filter((job) => job.name === 'publish');
  assert.equal(publishers.length, 1, 'prior publish job identity is unconfirmed');
  const job = publishers[0];
  assert.ok(Array.isArray(job.steps), 'prior publish job steps are unavailable');
  const steps = job.steps.filter((step) => step.name === PUBLISH_STEP_NAME);
  assert.ok((job.conclusion === 'skipped' && job.steps.length === 0)
    || (steps.length === 1 && steps[0].status === 'completed' && steps[0].conclusion === 'skipped'),
  'prior publish may have executed but its journal is missing; do not republish: owner must reconcile the prior attempt');
}

function publicationJournal(entries, sha, version, tag, options, root) {
  const filename = options.journalPath || path.join(path.dirname(root), 'publication-journal.json');
  const runId = options.runId || 'local';
  const runAttempt = Number(options.runAttempt || 1);
  assert.match(runId, /^(?:local|[1-9][0-9]*)$/, 'invalid publication journal run identity');
  assert.ok(Number.isSafeInteger(runAttempt) && runAttempt > 0, 'invalid publication journal run attempt');
  const scope = { format: 1, sourceSha: sha, version, tag, runId };
  const receipts = new Map();
  const files = [];
  if (options.historyRoot && fs.existsSync(options.historyRoot)) {
    for (const item of fs.readdirSync(options.historyRoot, { withFileTypes: true })) {
      assert.ok(item.isDirectory(), 'publication journal history must contain artifact directories');
      const match = new RegExp(`^holycodex-publish-journal-${runId}-([1-9][0-9]*)$`).exec(item.name);
      assert.ok(match && Number(match[1]) < runAttempt, 'unexpected publication journal artifact identity');
      files.push({ filename: path.join(options.historyRoot, item.name, 'publication-journal.json'), attempt: Number(match[1]) });
    }
  }
  for (let attempt = 1; attempt < runAttempt; attempt++) {
    if (!files.some((file) => file.attempt === attempt)) verifyUnstartedAttempt(options.historyProofRoot
      && path.join(options.historyProofRoot, `attempt-${attempt}.json`), runId, sha);
  }
  if (fs.existsSync(filename)) files.push({ filename, attempt: runAttempt });
  for (const file of files) {
    const journal = JSON.parse(fs.readFileSync(file.filename, 'utf8'));
    for (const [key, value] of Object.entries(scope)) assert.equal(journal[key], value, `publication journal ${key} differs`);
    assert.equal(journal.runAttempt, file.attempt, 'publication journal attempt differs');
    assert.ok(Array.isArray(journal.receipts), 'invalid publication journal receipts');
    const names = new Set();
    for (const receipt of journal.receipts) {
      assert.ok(receipt && typeof receipt === 'object', 'invalid publication journal receipt');
      const entry = entries.find((candidate) => candidate.name === receipt.name);
      assert.ok(entry && !names.has(receipt.name), 'unknown or duplicate publication journal package');
      names.add(receipt.name);
      assert.equal(receipt.integrity, entry.integrity, `publication journal integrity differs for ${receipt.name}`);
      assert.ok(RECEIPT_STATES.includes(receipt.state), 'invalid publication journal state');
      assert.ok(receipt.latest === null || (typeof receipt.latest === 'string' && receipt.latest.length > 0),
        'invalid publication journal latest baseline');
      const prior = receipts.get(receipt.name);
      if (prior) assert.equal(receipt.latest, prior.latest, 'publication journals disagree about original latest baseline');
      if (!prior || RECEIPT_STATES.indexOf(receipt.state) > RECEIPT_STATES.indexOf(prior.state)) receipts.set(receipt.name, receipt);
    }
  }
  const save = () => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...scope, runAttempt, receipts: [...receipts.values()] }, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
  };
  save(); // Persist the cumulative restored history before touching the registry.
  return { receipts, record(entry, state) {
    const latest = receipts.has(entry.name) ? receipts.get(entry.name).latest : (entry.latest ?? null);
    receipts.set(entry.name, { name: entry.name, integrity: entry.integrity, latest, state });
    save();
  } };
}

// npm is not a multi-package transaction. Artifacts and registry conflicts are
// preflighted before writes; native versions are confirmed before the wrapper.
// A durable attempted receipt precedes each npm call. A 404 never erases that
// receipt or permits another publish, even when npm's response was lost.
async function publishPackages(root, sha, version, channel, adapter = {}) {
  validateVersion(version, channel);
  verifyRelease(root, sha, version);
  const read = adapter.read || registryPackage;
  const publish = adapter.publish || ((archive, tag) => execFileSync('npm',
    ['publish', archive, '--access', 'public', '--tag', tag, '--provenance'], { stdio: 'inherit' }));
  const wait = adapter.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = adapter.now || Date.now;
  const tag = channel === 'dev' ? 'dev' : 'latest';
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  const entries = [...PLATFORM_PACKAGES, 'holycodex'].map((name) => {
    const candidates = directories.map((directory) => path.join(directory, tarballName(name, version)))
      .filter((filename) => fs.existsSync(filename));
    assert.equal(candidates.length, 1, `expected one archive for ${name}`);
    const archive = candidates[0];
    const integrity = `sha512-${createHash('sha512').update(fs.readFileSync(archive)).digest('base64')}`;
    return { name, archive, integrity };
  });
  const journal = publicationJournal(entries, sha, version, tag, adapter, root);
  const inspect = (entry, metadata) => {
    if (!metadata) return false;
    assert.equal(metadata.name, entry.name, 'registry package identity mismatch');
    const receipt = journal.receipts.get(entry.name);
    if (channel === 'dev' && receipt) assert.equal(metadata['dist-tags']?.latest ?? null, receipt.latest,
      `DEV unexpectedly changed latest for ${entry.name}`);
    const existing = metadata.versions?.[version];
    if (existing) assert.equal(existing.dist?.integrity, entry.integrity,
      `existing ${entry.name}@${version} differs from validated artifact`);
    return Boolean(existing && metadata['dist-tags']?.[tag] === version);
  };
  const poll = async (entry, accepts, message) => {
    const deadline = now() + READBACK_TIMEOUT_MS;
    let waited = 0;
    for (let attempt = 0; attempt <= POLL_DELAYS_MS.length; attempt++) {
      const remaining = Math.min(READBACK_TIMEOUT_MS - waited, deadline - now());
      if (remaining <= 0) break;
      let metadata;
      try { metadata = await read(entry.name, Math.max(1, Math.min(30000, remaining))); }
      catch { /* A transport failure cannot establish absence or authorize a write. */ }
      if (accepts(metadata)) return metadata;
      if (attempt === POLL_DELAYS_MS.length) break;
      const delay = Math.min(POLL_DELAYS_MS[attempt], READBACK_TIMEOUT_MS - waited, deadline - now());
      if (delay <= 0) break;
      await wait(delay);
      waited += delay;
    }
    throw new Error(message);
  };
  const pendingMessage = (entry) => `${entry.name}@${version}: ${journal.receipts.get(entry.name)?.state === 'accepted'
    ? 'accepted publication pending verification' : 'publication attempt pending verification (result may be ambiguous)'}; ` +
    `integrity/tag readback failed after up to 300 seconds; do not republish or select a new version. ` +
    `Retry verification with the same artifacts and retained journal after registry processing settles; ${
      entry.name === 'holycodex' ? 'wrapper may already be published' : 'wrapper publication is withheld'}`;
  const confirm = async (entry) => poll(entry, (metadata) => {
    const exact = inspect(entry, metadata);
    if (channel === 'dev' && metadata && entry.hasLatestBaseline) assert.equal(metadata['dist-tags']?.latest, entry.latest,
      `DEV unexpectedly changed latest for ${entry.name}`);
    return exact;
  }, pendingMessage(entry));

  // Preflight every package, including receipts from prior attempts, before any
  // new npm write. Missing metadata is allowed to settle, never treated as proof
  // that a previous publish did not reach npm.
  for (const entry of entries) {
    const receipt = journal.receipts.get(entry.name);
    let metadata = await read(entry.name);
    if (!metadata && !receipt) metadata = await poll(entry, (candidate) => {
      inspect(entry, candidate);
      return Boolean(candidate);
    }, `${entry.name}: registry availability is unconfirmed; owner must verify bootstrap and trusted publishing before any automated publish`);
    entry.existing = inspect(entry, metadata);
    entry.latest = metadata?.['dist-tags']?.latest;
    entry.hasLatestBaseline = Boolean(metadata);
    if (!receipt && metadata?.versions?.[version]) assert.ok(entry.existing,
      `existing ${entry.name}@${version} does not have ${tag}; owner must reconcile the dist-tag`);
  }
  for (const entry of entries) {
    if (journal.receipts.has(entry.name) && !entry.existing) {
      await confirm(entry);
      entry.existing = true;
      journal.record(entry, 'verified');
    }
  }
  for (const entry of entries) {
    if (!entry.existing) {
      journal.record(entry, 'attempted');
      let accepted = false;
      try {
        await publish(entry.archive, tag);
        accepted = true;
      } catch {
        // Even a nonzero/lost CLI response can follow server-side acceptance.
        // Only exact registry verification, never another publish, can recover.
      }
      if (accepted) journal.record(entry, 'accepted');
    }
    await confirm(entry);
    journal.record(entry, 'verified');
  }
}

if (require.main === module) {
  const [root, sha, version, channel, journalPath, historyRoot, historyProofRoot] = process.argv.slice(2);
  publishPackages(root, sha, version, channel, {
    journalPath, historyRoot, historyProofRoot, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { publishPackages, READBACK_TIMEOUT_MS, POLL_DELAYS_MS };
