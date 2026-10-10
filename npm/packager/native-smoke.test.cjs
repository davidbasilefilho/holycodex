'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { TARGETS, expectedRuntimeVersion, verifyNativeHeader, smokeNative } = require('./native-smoke.cjs');
const { MAX_ARCHIVE_BYTES, MAX_NATIVE_BYTES, verifyArchiveSize, verifyNativeAliases, tarFile } = require('./verify-release.cjs');
const { BASE_VERSION, distributionVersion, stageChannel, tarballName } = require('./channel.cjs');
const HOST_TARGET = Object.keys(TARGETS).find((key) => TARGETS[key].platform === process.platform && TARGETS[key].arch === process.arch);
const SUPPORTED_HOST = Boolean(HOST_TARGET) && (process.platform !== 'linux' || Boolean(process.report.getReport().header.glibcVersionRuntime));
const nativeTest = (name, body) => test(name, { skip: !SUPPORTED_HOST }, body);

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-smoke-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Header/runner fixtures exercise the gate's assertions only. They are not
// executable HolyCodex binaries and do not supply runtime acceptance evidence.
function header(target) {
  const bytes = Buffer.alloc(128);
  if (target === 'linux-x64-gnu') {
    bytes.write('7f454c46', 0, 'hex');
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(62, 18);
  } else if (target === 'darwin-arm64') {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(0x0100000c, 4);
  } else {
    bytes.write('MZ');
    bytes.writeUInt32LE(64, 60);
    bytes.write('50450000', 64, 'hex');
    bytes.writeUInt16LE(0x8664, 68);
  }
  return bytes;
}

function fixture(t, channel = 'dev') {
  const root = temporary(t);
  const target = HOST_TARGET || 'linux-x64-gnu';
  const name = `@turndev/holycodex-native-${target}`;
  const version = distributionVersion(channel, '123');
  const directory = path.join(root, 'package');
  fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', `holycodex-native-${target}`, 'package.json'), path.join(directory, 'package.json'));
  const extension = target === 'win32-x64' ? '.exe' : '';
  const bytes = header(target);
  for (const alias of ['holycodex', 'codex']) fs.writeFileSync(path.join(directory, 'bin', alias + extension), bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(directory, 'payload.toml'), `format = 1\npackage = "${name}"\nversion = "${BASE_VERSION}"\nsha256 = "${digest}"\n`);
  stageChannel(directory, version, channel);
  const archive = path.join(root, tarballName(name, version));
  const repack = () => execFileSync('tar', ['-czf', `./${path.basename(archive)}`, 'package'], { cwd: root });
  repack();
  return { root, target, version, directory, archive, repack, extension, digest };
}

function successfulRunner(filename, args) {
  return args[0] === '--version' ? expectedRuntimeVersion() + '\n' : 'HolyCodex CLI\n\nUsage: holycodex [OPTIONS] [PROMPT]\n';
}

// Dense members avoid platform-specific sparse tar extraction behavior. Keep
// fixture construction bounded in memory just like production verification.
function writeZeroBytes(filename, bytes) {
  const fd = fs.openSync(filename, 'w');
  const chunk = Buffer.alloc(64 * 1024);
  try {
    for (let remaining = bytes; remaining > 0;) {
      const length = Math.min(chunk.length, remaining);
      let written = 0;
      while (written < length) written += fs.writeSync(fd, chunk, written, length - written);
      remaining -= length;
    }
  } finally { fs.closeSync(fd); }
}

for (const channel of ['dev', 'stable']) {
  nativeTest(`${channel} gate checks both packed aliases and pinned runtime separately from npm version`, (t) => {
    const f = fixture(t, channel);
    const calls = [];
    const result = smokeNative(f.archive, f.target, f.version, (filename, args, options) => {
      calls.push({ filename, args, options });
      assert.ok(fs.existsSync(filename));
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.equal(options.encoding, 'utf8');
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.env.HOME, options.cwd);
      assert.equal(options.env.USERPROFILE, options.cwd);
      assert.equal(options.env.CODEX_HOME, path.join(options.cwd, 'codex-home'));
      assert.ok(fs.existsSync(options.env.CODEX_HOME));
      if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o700);
      return successfulRunner(filename, args);
    });
    assert.deepEqual(calls.map(({ filename, args }) => [path.basename(filename), ...args]), [
      [`holycodex${f.extension}`, '--version'], [`holycodex${f.extension}`, '--help'],
      [`codex${f.extension}`, '--version'], [`codex${f.extension}`, '--help'],
    ]);
    assert.equal(result.nativeBytes, 128);
    assert.equal(result.compressedBytes, fs.statSync(f.archive).size);
    assert.equal(result.payloadSha256, f.digest);
    assert.equal(result.distributionVersion, f.version);
    assert.equal(result.runtimeVersion, 'holycodex 0.17.0 (Codex upstream 0.160.1)');
    for (const { filename, options } of calls) {
      assert.equal(fs.existsSync(filename), false);
      assert.equal(fs.existsSync(options.cwd), false);
    }
  });
}

nativeTest('wrong runtime identity, broken help, and subprocess failures block native artifacts', (t) => {
  const f = fixture(t);
  for (const output of ['codex 0.160.1', `holycodex ${f.version} (Codex upstream 0.160.1)`, 'holycodex 0.17.0']) {
    assert.throws(() => smokeNative(f.archive, f.target, f.version, () => output), /runtime identity\/version mismatch/);
  }
  for (const output of ['Codex CLI\nUsage: holycodex ', 'HolyCodex CLI\nUsage: codex ']) {
    assert.throws(() => smokeNative(f.archive, f.target, f.version, (file, args) => args[0] === '--version' ? expectedRuntimeVersion() : output), /missing native CLI identity|wrong CLI entrypoint/);
  }
  const failure = Object.assign(new Error('native launch failed or timed out'), { code: 'ETIMEDOUT' });
  assert.throws(() => smokeNative(f.archive, f.target, f.version, () => { throw failure; }), (error) => error === failure);
});

nativeTest('foreign target, distribution identity, alias mismatch, and digest corruption fail before launch', (t) => {
  const f = fixture(t);
  const launch = () => assert.fail('unverified bytes must never launch');
  const foreign = Object.keys(TARGETS).find((target) => target !== f.target);
  assert.throws(() => smokeNative(f.archive, foreign, f.version, launch), /advertised OS|advertised architecture/);
  assert.throws(() => smokeNative(f.archive, f.target, BASE_VERSION, launch), /distribution version mismatch/);
  const second = path.join(f.directory, 'bin', `codex${f.extension}`);
  const altered = header(f.target);
  altered[127] = 1;
  fs.writeFileSync(second, altered);
  f.repack();
  assert.throws(() => smokeNative(f.archive, f.target, f.version, launch), /executable aliases differ/);
  fs.copyFileSync(second, path.join(f.directory, 'bin', `holycodex${f.extension}`));
  f.repack();
  assert.throws(() => smokeNative(f.archive, f.target, f.version, launch), /payload digest mismatch/);
});

test('native headers reject scripts, wrong architecture, and truncated executables on all targets', (t) => {
  const root = temporary(t);
  const filename = path.join(root, 'fixture');
  for (const target of Object.keys(TARGETS)) {
    fs.writeFileSync(filename, header(target));
    verifyNativeHeader(filename, target);
    for (const bytes of [Buffer.from('#!/bin/sh\necho fake'), Buffer.alloc(128)]) {
      fs.writeFileSync(filename, bytes);
      assert.throws(() => verifyNativeHeader(filename, target));
    }
    const wrong = header(target);
    const offset = target === 'linux-x64-gnu' ? 18 : target === 'darwin-arm64' ? 4 : 68;
    wrong[offset] = 0;
    fs.writeFileSync(filename, wrong);
    assert.throws(() => verifyNativeHeader(filename, target), /expected x64|expected arm64/);
  }
});

test('compressed size and native size budgets reject debug-bloat regressions', (t) => {
  const f = fixture(t);
  assert.equal(MAX_ARCHIVE_BYTES, 256 * 1024 * 1024);
  assert.equal(MAX_NATIVE_BYTES, 384 * 1024 * 1024);
  const oversizedArchive = path.join(f.root, 'oversized.tgz');
  const fd = fs.openSync(oversizedArchive, 'w');
  fs.ftruncateSync(fd, MAX_ARCHIVE_BYTES + 1);
  fs.closeSync(fd);
  assert.throws(() => verifyArchiveSize(oversizedArchive), /tarball exceeds/);
  // A dense compressible member proves the unpacked bound independently.
  const executable = path.join(f.directory, 'bin', `holycodex${f.extension}`);
  writeZeroBytes(executable, MAX_NATIVE_BYTES + 1);
  f.repack();
  assert.ok(fs.statSync(f.archive).size < MAX_ARCHIVE_BYTES);
  assert.throws(() => verifyNativeAliases(f.archive, f.extension, f.digest, f.root), /native executable exceeds/);
});

test('calibrated expanded budget accepts verified aliases above the old 256 MiB bound', (t) => {
  const f = fixture(t);
  const bytes = 256 * 1024 * 1024 + 1;
  for (const alias of ['holycodex', 'codex']) {
    writeZeroBytes(path.join(f.directory, 'bin', alias + f.extension), bytes);
  }
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024);
  for (let remaining = bytes; remaining > 0; remaining -= chunk.length) {
    hash.update(chunk.subarray(0, Math.min(chunk.length, remaining)));
  }
  f.repack();
  assert.ok(fs.statSync(f.archive).size < MAX_ARCHIVE_BYTES);
  assert.equal(verifyNativeAliases(f.archive, f.extension, hash.digest('hex'), f.root), bytes);
});

test('release build strips only distribution profiles and smoke runs before artifact upload', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/release.yml'), 'utf8');
  const build = workflow.indexOf('- name: Build one native runtime under both names');
  const stage = workflow.indexOf('- name: Stage and pack platform npm package', build);
  const smoke = workflow.indexOf('node npm/packager/native-smoke.cjs', stage);
  const upload = workflow.indexOf('- uses: actions/upload-artifact@', stage);
  assert.ok(build > 0 && stage > build && smoke > stage && upload > smoke);
  assert.match(workflow.slice(build, stage), /CARGO_PROFILE_RELEASE_DEBUG: "0"/);
  assert.match(workflow.slice(build, stage), /CARGO_PROFILE_RELEASE_STRIP: symbols/);
  assert.doesNotMatch(workflow.slice(0, build), /CARGO_PROFILE_RELEASE_(DEBUG|STRIP)/);
  assert.match(workflow.slice(stage, smoke), /npm pack --pack-destination/);
});


test('archive extraction uses a local basename even when paths contain drive-like colons', (t) => {
  const f = fixture(t);
  // Colons cannot be created in Windows basenames, whose absolute paths already
  // exercise the drive-letter case; POSIX also exercises GNU tar's remote syntax.
  const archive = process.platform === 'win32' ? f.archive : path.join(f.root, 'local:artifact.tgz');
  if (archive !== f.archive) fs.renameSync(f.archive, archive);
  assert.equal(JSON.parse(tarFile(archive, 'package.json')).version, f.version);
  assert.equal(verifyNativeAliases(archive, f.extension, f.digest, f.root), 128);
});
