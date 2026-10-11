'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { smokeInstallation, installArguments, isolatedEnvironment, verifyInstalledFiles, npmCli } = require('./installation-smoke.cjs');
const { TARGETS, expectedRuntimeVersion } = require('./native-smoke.cjs');
const { BASE_VERSION, stageChannel, tarballName } = require('./channel.cjs');

const TARGET = Object.keys(TARGETS).find((key) => TARGETS[key].platform === process.platform && TARGETS[key].arch === process.arch);
const SUPPORTED = Boolean(TARGET) && (process.platform !== 'linux' || Boolean(process.report.getReport().header.glibcVersionRuntime));
const nativeTest = (name, body) => test(name, { skip: !SUPPORTED, timeout: 240_000 }, body);

test('the gate requires the selected npm CLI instead of silently using Node bundled npm', () => {
  const selected = process.env.npm_execpath;
  assert.ok(selected, 'run consumer tests through npm exec --offline --call');
  assert.equal(npmCli(), selected);
  try {
    delete process.env.npm_execpath;
    assert.throws(npmCli, /tests the selected npm CLI/);
    process.env.npm_execpath = process.execPath;
    assert.throws(npmCli, /tests the selected npm CLI/);
  } finally {
    process.env.npm_execpath = selected;
  }
});

function header(target) {
  const bytes = Buffer.alloc(128);
  if (target === 'linux-x64-gnu') {
    bytes.write('7f454c46', 0, 'hex'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(62, 18);
  } else if (target === 'darwin-arm64') {
    bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
  } else {
    bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('50450000', 64, 'hex'); bytes.writeUInt16LE(0x8664, 68);
  }
  return bytes;
}

function fixture(t, channel = 'dev') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-installation-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const target = TARGET || 'linux-x64-gnu';
  const name = `@turndev/holycodex-native-${target}`;
  const version = channel === 'dev' ? `${BASE_VERSION}-dev.123` : BASE_VERSION;
  const bytes = header(target);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const extension = target === 'win32-x64' ? '.exe' : '';
  const nativeDirectory = path.join(root, 'native', 'package');
  const wrapperDirectory = path.join(root, 'wrapper', 'package');
  for (const directory of [nativeDirectory, wrapperDirectory]) fs.mkdirSync(path.join(directory, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', name.replace('@turndev/', ''), 'package.json'), path.join(nativeDirectory, 'package.json'));
  fs.copyFileSync(path.join(__dirname, '../holycodex/package.json'), path.join(wrapperDirectory, 'package.json'));
  fs.copyFileSync(path.join(__dirname, '../holycodex/install.cjs'), path.join(wrapperDirectory, 'install.cjs'));
  fs.writeFileSync(path.join(nativeDirectory, 'payload.toml'), `format = 1\npackage = "${name}"\nversion = "${BASE_VERSION}"\nsha256 = "${digest}"\n`);
  for (const alias of ['holycodex', 'codex']) {
    fs.writeFileSync(path.join(nativeDirectory, 'bin', alias + extension), bytes, { mode: 0o755 });
    fs.writeFileSync(path.join(wrapperDirectory, 'bin', `${alias}.exe`), '');
  }
  require('./resource-fixture.cjs').resourceFixture(nativeDirectory, target, bytes);
  fs.copyFileSync(path.join(__dirname, '../holycodex/native-inventory.json'), path.join(wrapperDirectory, 'native-inventory.json'));
  for (const directory of [nativeDirectory, wrapperDirectory]) stageChannel(directory, version, channel);
  const native = path.join(root, tarballName(name, version));
  const wrapper = path.join(root, tarballName('holycodex', version));
  const repack = () => {
    for (const [archive, directory] of [[native, nativeDirectory], [wrapper, wrapperDirectory]]) {
      execFileSync('tar', ['-czf', `../${path.basename(archive)}`, 'package'], { cwd: path.dirname(directory), timeout: 30_000 });
    }
  };
  repack();
  return { root, target, version, bytes, digest, extension, nativeDirectory, wrapperDirectory, native, wrapper, repack };
}

function isVersionProbe(args) {
  return args.some((arg) => arg === '--version' || /^(?:holycodex|codex)\.cmd --version$/.test(arg));
}

test('runtime response fixtures recognize direct and Windows cmd version probes', () => {
  for (const alias of ['holycodex', 'codex']) {
    for (const flag of ['--version', '--help']) {
      assert.equal(isVersionProbe([flag]), flag === '--version');
      assert.equal(isVersionProbe(['/d', '/s', '/c', `${alias}.cmd ${flag}`]), flag === '--version');
    }
  }
});

function runtimeOutput(args) {
  return isVersionProbe(args) ? expectedRuntimeVersion() + '\n' : 'HolyCodex CLI\n\nUsage: holycodex [OPTIONS] [PROMPT]\n';
}

// Header-only artifacts plus an injected runtime runner test the smoke gate's
// mechanics, not HolyCodex behavior. npm itself really installs the untouched
// archives and runs their real postinstall. Release CI supplies actual binaries.
for (const channel of ['dev', 'stable']) {
  nativeTest(`${channel}: exact archives install offline and every installed alias is checked without Node on PATH`, (t) => {
    const f = fixture(t, channel);
    const before = [f.wrapper, f.native].map((filename) => fs.readFileSync(filename));
    const calls = [];
    const result = smokeInstallation(f.wrapper, f.native, f.target, f.version, { run(filename, args, options) {
      calls.push({ filename, args, options });
      assert.equal(options.encoding, 'utf8');
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.env.HOME, options.env.USERPROFILE);
      assert.ok(fs.existsSync(options.env.CODEX_HOME));
      if (filename === process.execPath) {
        if (args[1] === '--version') {
          assert.deepEqual(fs.readdirSync(options.env.npm_config_cache), [], 'cache must start empty');
          assert.equal(options.timeout, 30_000);
        } else {
          assert.ok(args.includes('--offline'));
          assert.ok(args.includes('--global'));
          assert.deepEqual(args.slice(-2), [f.native, f.wrapper]);
          assert.equal(options.timeout, 180_000);
          const prefix = args[args.indexOf('--prefix') + 1];
          assert.deepEqual(fs.readdirSync(path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules')), [],
            'strict approval preflight must see an existing empty global tree');
        }
        return execFileSync(filename, args, options);
      }
      assert.equal(options.timeout, 30_000);
      assert.equal(options.env.PATH, '');
      assert.equal(Object.keys(options.env).filter((key) => key.toLowerCase() === 'path').length, 1);
      return runtimeOutput(args);
    } });
    assert.equal(calls.length, 10, 'version probe, install, then two flags through native files and both public commands');
    const launches = calls.slice(2);
    for (const alias of ['holycodex', 'codex']) {
      assert.equal(launches.filter(({ filename }) => path.basename(filename) === `${alias}.exe`).length, 2);
      assert.equal(launches.filter(({ filename, args }) => process.platform === 'win32'
        ? args.at(-1).startsWith(`${alias}.cmd `) : path.basename(filename) === alias).length, 2);
    }
    assert.equal(result.distributionVersion, f.version);
    assert.equal(result.runtimeVersion, expectedRuntimeVersion());
    assert.equal(result.installMode, 'isolated-global-offline');
    assert.equal(result.postinstallVerified, true);
    assert.equal(result.runtimePath, '');
    assert.equal(result.nativeBytes, 128);
    assert.equal(result.payloadSha256, f.digest);
    assert.match(result.npmVersion, /^\d+\.\d+\.\d+/);
    for (const call of calls) assert.equal(fs.existsSync(call.options.env.HOME), false, 'isolated install must be cleaned up');
    for (const [index, archive] of [f.wrapper, f.native].entries()) assert.ok(fs.readFileSync(archive).equals(before[index]), 'archive must not be rewritten');
  });
}

test('npm 12 uses only the documented per-command global script allowlist', () => {
  const base = installArguments('/wrapper.tgz', '/native.tgz', '/prefix', '11.9.0');
  assert.ok(base.includes('--global'));
  assert.equal(base.some((arg) => /allow-scripts/.test(arg)), false);
  const args = installArguments('/wrapper.tgz', '/native.tgz', '/prefix', '12.2.0');
  assert.ok(args.includes('--allow-scripts=file:/wrapper.tgz'));
  assert.ok(args.includes('--strict-allow-scripts'));
  assert.equal(args.some((arg) => /ignore-scripts|allow-scripts=all|force|config|approve-scripts/.test(arg)), false);
  assert.throws(() => installArguments('wrapper', 'native', 'prefix', 'unknown'), /invalid npm version/);
  assert.throws(() => installArguments('/with,comma/wrapper.tgz', 'native', 'prefix', '12.2.0'), /path without commas/);
  assert.ok(installArguments('C:\\artifacts\\wrapper.tgz', 'native', 'prefix', '12.2.0').includes('--allow-scripts=file:C:/artifacts/wrapper.tgz'));
});

test('isolated subprocesses receive no credentials, preloads, real homes, or existing npm settings', () => {
  const root = path.resolve('temporary-home');
  const env = isolatedEnvironment(root, { Path: '/tools', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    HOME: '/real-home', CODEX_HOME: '/real-codex', APPDATA: '/real-appdata', NODE_OPTIONS: '--require malicious.cjs',
    NPM_CONFIG_PREFIX: '/real-prefix', npm_config_ignore_scripts: 'true', npm_config_allow_scripts: 'all',
    NODE_AUTH_TOKEN: 'never-forward', OPENAI_API_KEY: 'never-forward', GH_TOKEN: 'never-forward' });
  assert.equal(env.Path, '/tools');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.HOME, root);
  assert.equal(env.CODEX_HOME, path.join(root, 'codex-home'));
  for (const key of ['NODE_OPTIONS', 'NPM_CONFIG_PREFIX', 'npm_config_ignore_scripts', 'npm_config_allow_scripts', 'NODE_AUTH_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN']) assert.equal(env[key], undefined);
});

nativeTest('a successful npm exit with blocked postinstall cannot pass the gate', (t) => {
  const f = fixture(t);
  let home;
  assert.throws(() => smokeInstallation(f.wrapper, f.native, f.target, f.version, { run(filename, args, options) {
    home = options.env.HOME;
    assert.equal(filename, process.execPath, 'blocked postinstall must never reach runtime launch');
    return execFileSync(filename, args[1] === 'install' ? [...args, '--ignore-scripts'] : args, options);
  } }), /postinstall may have been blocked or skipped/);
  assert.equal(fs.existsSync(home), false);
});

nativeTest('npm errors and runtime timeouts fail and clean up the isolated prefix', (t) => {
  const f = fixture(t);
  for (const failRuntime of [false, true]) {
    const failure = Object.assign(new Error(failRuntime ? 'runtime timeout' : 'npm install failure'), { code: 'ETIMEDOUT' });
    let home;
    assert.throws(() => smokeInstallation(f.wrapper, f.native, f.target, f.version, { run(filename, args, options) {
      home = options.env.HOME;
      if (failRuntime ? filename !== process.execPath : args[1] === 'install') throw failure;
      return execFileSync(filename, args, options);
    } }), (error) => error === failure);
    assert.equal(fs.existsSync(home), false);
  }
});

nativeTest('wrong runtime version or help identity fails after an otherwise successful real npm install', (t) => {
  const f = fixture(t);
  for (const [output, message] of [
    ['codex 0.160.1', /runtime identity\/version mismatch/],
    ['Codex CLI\nUsage: holycodex ', /missing native CLI identity/],
    ['HolyCodex CLI\nUsage: codex ', /wrong CLI entrypoint/],
  ]) {
    let home;
    assert.throws(() => smokeInstallation(f.wrapper, f.native, f.target, f.version, { run(filename, args, options) {
      home = options.env.HOME;
      if (filename === process.execPath) return execFileSync(filename, args, options);
      return isVersionProbe(args) && output.includes('CLI') ? expectedRuntimeVersion() : output;
    } }), message);
    assert.equal(fs.existsSync(home), false);
  }
});

nativeTest('identity, exact dependencies, script policy, and placeholders are checked before npm runs', (t) => {
  const f = fixture(t);
  const invoke = () => smokeInstallation(f.wrapper, f.native, f.target, f.version, { run() { assert.fail('invalid archive must not install'); } });
  const filename = path.join(f.wrapperDirectory, 'package.json');
  const original = fs.readFileSync(filename);
  for (const mutate of [
    (metadata) => { metadata.name = 'wrong'; },
    (metadata) => { metadata.version = BASE_VERSION; },
    (metadata) => { metadata.optionalDependencies[Object.keys(metadata.optionalDependencies)[0]] = '^0.17.0'; },
    (metadata) => { metadata.scripts.postinstall = 'node other.cjs'; },
    (metadata) => { metadata.scripts.preinstall = 'node other.cjs'; },
  ]) {
    const metadata = JSON.parse(original);
    mutate(metadata);
    fs.writeFileSync(filename, JSON.stringify(metadata));
    f.repack();
    assert.throws(invoke, /identity mismatch|distribution version mismatch|exact release optional dependencies|postinstall contract|unexpected wrapper lifecycle/);
  }
  fs.writeFileSync(filename, original);
  fs.writeFileSync(path.join(f.wrapperDirectory, 'bin/codex.exe'), f.bytes);
  f.repack();
  assert.throws(invoke, /empty link placeholders/);
  const foreign = Object.keys(TARGETS).find((target) => target !== f.target);
  assert.throws(() => smokeInstallation(f.wrapper, f.native, foreign, f.version), /advertised OS|advertised architecture/);
});

nativeTest('installed bytes reject absent payloads, alias divergence, digest corruption, and non-native headers', (t) => {
  const f = fixture(t);
  const files = ['first', 'second', 'third', 'fourth'].map((name) => path.join(f.root, name));
  const reset = (bytes = f.bytes) => { for (const filename of files) fs.writeFileSync(filename, bytes, { mode: 0o755 }); };
  reset();
  assert.equal(verifyInstalledFiles(files, f.digest, f.target), f.bytes.length);
  fs.writeFileSync(files[2], '');
  assert.throws(() => verifyInstalledFiles(files, f.digest, f.target), /postinstall may have been blocked or skipped/);
  reset();
  const altered = Buffer.from(f.bytes); altered[127] = 1;
  fs.writeFileSync(files[3], altered);
  assert.throws(() => verifyInstalledFiles(files, f.digest, f.target), /aliases differ/);
  reset(altered);
  assert.throws(() => verifyInstalledFiles(files, f.digest, f.target), /archive digest/);
  reset(Buffer.alloc(128));
  assert.throws(() => verifyInstalledFiles(files, f.digest, f.target), /native ELF|native 64-bit Mach-O|native PE/);
});
