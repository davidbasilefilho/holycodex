'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { install, packageFor, readPayloadManifest } = require('./install.cjs');
const version = require('./package.json').version;

function fixture(t, platform = 'linux', arch = 'x64') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-npm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const optional = path.join(root, 'optional');
  fs.mkdirSync(path.join(optional, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'));
  const payload = Buffer.from('installer mechanics fixture');
  const name = packageFor(platform, arch);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }));
  fs.writeFileSync(path.join(optional, 'package.json'), JSON.stringify({ name, version }));
  fs.writeFileSync(path.join(optional, 'payload.toml'), `format = 1\npackage = "${name}"\nversion = "${version}"\nsha256 = "${createHash('sha256').update(payload).digest('hex')}"\n`);
  for (const command of ['holycodex', 'codex']) {
    fs.writeFileSync(path.join(optional, 'bin', command + (platform === 'win32' ? '.exe' : '')), payload);
    fs.writeFileSync(path.join(root, 'bin', `${command}.exe`), 'placeholder');
  }
  return { root, optional, options: { root, platform, arch, libc: 'glibc', resolvePackage: () => path.join(optional, 'package.json') } };
}

test('install replaces placeholders with verified identical bytes on every target', (t) => {
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']]) {
    const f = fixture(t, platform, arch);
    install(f.options);
    const holy = fs.readFileSync(path.join(f.root, 'bin/holycodex.exe'));
    assert.deepEqual(holy, fs.readFileSync(path.join(f.root, 'bin/codex.exe')));
    assert.equal(holy.toString(), 'installer mechanics fixture');
    if (process.platform !== 'win32' && platform !== 'win32') assert.equal(fs.statSync(path.join(f.root, 'bin/holycodex.exe')).mode & 0o111, 0o111);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'bin')).sort(), ['codex.exe', 'holycodex.exe']);
  }
});

test('a second alias rename failure restores original bytes, modes, and absent destinations', (t) => {
  for (const [platform, arch] of [['linux', 'x64'], ['darwin', 'arm64'], ['win32', 'x64']]) {
    for (const present of [[true, true], [false, false], [true, false], [false, true]]) {
      const f = fixture(t, platform, arch);
      const directory = path.join(f.root, 'bin');
      const destinations = ['holycodex', 'codex'].map((name) => path.join(directory, `${name}.exe`));
      const originals = destinations.map((destination, i) => {
        if (!present[i]) {
          fs.rmSync(destination);
          return undefined;
        }
        const bytes = Buffer.from(`previous ${path.basename(destination)}`);
        fs.writeFileSync(destination, bytes);
        if (process.platform !== 'win32') fs.chmodSync(destination, i === 0 ? 0o751 : 0o640);
        return { bytes, mode: fs.statSync(destination).mode & 0o7777 };
      });
      const failure = Object.assign(new Error('injected second alias rename failure'), { code: 'EIO' });
      const rename = fs.renameSync;
      let failures = 0;
      try {
        fs.renameSync = (source, destination) => {
          if (destination === destinations[1]) {
            failures++;
            assert.equal(fs.readFileSync(destinations[0], 'utf8'), 'installer mechanics fixture');
            throw failure;
          }
          return rename(source, destination);
        };
        assert.throws(() => install(f.options), (error) => error === failure);
      } finally {
        fs.renameSync = rename;
      }
      assert.equal(failures, 1);
      for (let i = 0; i < destinations.length; i++) {
        if (!originals[i]) assert.equal(fs.existsSync(destinations[i]), false);
        else {
          assert.deepEqual(fs.readFileSync(destinations[i]), originals[i].bytes);
          assert.equal(fs.statSync(destinations[i]).mode & 0o7777, originals[i].mode);
        }
      }
      assert.deepEqual(fs.readdirSync(directory).sort(), destinations.filter((_, i) => present[i]).map((destination) => path.basename(destination)).sort());
    }
  }
});

test('a Windows-locked second alias stays untouched while the first alias rolls back', (t) => {
  const f = fixture(t, 'win32');
  const first = path.join(f.root, 'bin/holycodex.exe');
  const locked = path.join(f.root, 'bin/codex.exe');
  const failure = Object.assign(new Error('EPERM: executable is in use'), { code: 'EPERM' });
  const { renameSync, rmSync, writeFileSync, copyFileSync } = fs;
  let replacements = 0;
  let lockedOperations = 0;
  function checkUnlocked(filename) {
    if (filename === locked) {
      lockedOperations++;
      throw failure;
    }
  }
  try {
    fs.renameSync = (source, destination) => {
      checkUnlocked(source);
      checkUnlocked(destination);
      if (destination === first && !source.endsWith('.bak')) replacements++;
      return renameSync(source, destination);
    };
    fs.rmSync = (filename, ...args) => { checkUnlocked(filename); return rmSync(filename, ...args); };
    fs.writeFileSync = (filename, ...args) => { checkUnlocked(filename); return writeFileSync(filename, ...args); };
    fs.copyFileSync = (source, destination, ...args) => { checkUnlocked(destination); return copyFileSync(source, destination, ...args); };
    assert.throws(() => install(f.options), (error) => error === failure);
  } finally {
    Object.assign(fs, { renameSync, rmSync, writeFileSync, copyFileSync });
  }
  assert.equal(replacements, 1);
  assert.equal(lockedOperations, 1, 'rollback must not try to modify the untouched locked alias');
  assert.equal(fs.readFileSync(first, 'utf8'), 'placeholder');
  assert.equal(fs.readFileSync(locked, 'utf8'), 'placeholder');
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'bin')).sort(), ['codex.exe', 'holycodex.exe']);
});

test('a rollback failure reports both errors and keeps recovery copies', (t) => {
  const f = fixture(t);
  const failure = new Error('injected second alias rename failure');
  const rollbackFailure = new Error('injected rollback rename failure');
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, destination) => {
      if (destination === path.join(f.root, 'bin/codex.exe')) throw failure;
      if (source.endsWith('.bak')) throw rollbackFailure;
      return rename(source, destination);
    };
    assert.throws(() => install(f.options), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure, rollbackFailure]);
      assert.equal(error.cause, failure);
      assert.match(error.message, /rollback was incomplete; recovery files remain in/);
      return true;
    });
  } finally {
    fs.renameSync = rename;
  }
  const directory = path.join(f.root, 'bin');
  const recovery = fs.readdirSync(directory).find((entry) => entry.startsWith('.holycodex-install-'));
  assert.ok(recovery);
  for (const name of ['holycodex', 'codex']) assert.equal(fs.readFileSync(path.join(directory, recovery, `${name}.exe.bak`), 'utf8'), 'placeholder');
});

test('missing payload, invalid metadata, and checksum mismatch leave placeholders untouched', (t) => {
  for (const corrupt of [
    (f) => fs.rmSync(path.join(f.optional, 'bin/codex')),
    (f) => fs.rmSync(path.join(f.optional, 'payload.toml')),
    (f) => fs.writeFileSync(path.join(f.optional, 'bin/codex'), 'corrupt alias'),
    (f) => fs.writeFileSync(path.join(f.optional, 'payload.toml'), 'format = 1\npackage = "wrong-package"\n'),
    (f) => fs.writeFileSync(path.join(f.optional, 'package.json'), JSON.stringify({ name: 'wrong-package', version })),
  ]) {
    const f = fixture(t);
    corrupt(f);
    assert.throws(() => install(f.options));
    for (const name of ['holycodex', 'codex']) assert.equal(fs.readFileSync(path.join(f.root, 'bin', `${name}.exe`), 'utf8'), 'placeholder');
  }
});

test('payload proof parser rejects extra fields and malformed TOML values', () => {
  const filename = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-payload-toml-')), 'payload.toml');
  try {
    fs.writeFileSync(filename, `format = 1\npackage = "@turndev/holycodex-native-linux-x64-gnu"\nversion = "${version}"\nsha256 = "${'a'.repeat(64)}"\n`);
    assert.equal(readPayloadManifest(filename).package, '@turndev/holycodex-native-linux-x64-gnu');
    fs.appendFileSync(filename, 'unexpected = true\n');
    assert.throws(() => readPayloadManifest(filename), /TOML is invalid/);
  } finally {
    fs.rmSync(path.dirname(filename), { recursive: true, force: true });
  }
});

test('unsupported platform, musl, and missing dependency fail explicitly', () => {
  assert.throws(() => install({ platform: 'linux', arch: 'arm64' }), /no native npm package/);
  assert.throws(() => install({ platform: 'linux', arch: 'x64', libc: 'musl' }), /glibc only/);
  assert.throws(() => install({ platform: 'win32', arch: 'x64', resolvePackage: () => { throw Error('missing'); } }), /optional dependencies enabled/);
});

// A separately compiled native stub proves npm lifecycle/link mechanics only.
// It supplies no evidence about the HolyCodex runtime, authentication, or host.
test('clean offline npm install launches native fixture bins; ignored scripts leave placeholders', (t) => {
  const packageName = packageFor(process.platform, process.arch);
  assert.ok(packageName, 'fixture host must match the release matrix');
  assert.ok(process.env.npm_execpath, 'run through npm test');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-local-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = path.join(root, 'native');
  const wrapper = path.join(root, 'wrapper');
  const tarballs = path.join(root, 'tarballs');
  fs.mkdirSync(path.join(native, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(wrapper, 'bin'), { recursive: true });
  fs.mkdirSync(tarballs);
  const source = path.join(root, 'fixture.rs');
  fs.writeFileSync(source, 'fn main() { println!("holycodex native install fixture"); }');
  const extension = process.platform === 'win32' ? '.exe' : '';
  const executable = path.join(native, 'bin', `holycodex${extension}`);
  const fixtureEnv = { ...process.env };
  if (process.env.HOLYCODEX_FIXTURE_TOOLCHAIN) fixtureEnv.RUSTUP_TOOLCHAIN = process.env.HOLYCODEX_FIXTURE_TOOLCHAIN;
  const build = spawnSync(process.env.HOLYCODEX_FIXTURE_RUSTC || 'rustc', [source, '-o', executable], { encoding: 'utf8', env: fixtureEnv });
  assert.equal(build.status, 0, build.error?.message || build.stderr);
  fs.copyFileSync(executable, path.join(native, 'bin', `codex${extension}`));
  fs.writeFileSync(path.join(native, 'package.json'), JSON.stringify(require(path.join('..', packageName.replace('@turndev/', ''), 'package.json'))));
  fs.writeFileSync(path.join(native, 'payload.toml'), `format = 1\npackage = "${packageName}"\nversion = "${version}"\nsha256 = "${createHash('sha256').update(fs.readFileSync(executable)).digest('hex')}"\n`);
  const npmEnv = { ...process.env, npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'npmrc'), npm_config_globalconfig: path.join(root, 'global-npmrc') };
  fs.writeFileSync(npmEnv.npm_config_userconfig, '');
  fs.writeFileSync(npmEnv.npm_config_globalconfig, '');
  function npm(args, cwd = root) {
    const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env: npmEnv, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result.stdout;
  }
  const nativeTar = JSON.parse(npm(['pack', native, '--json', '--pack-destination', tarballs]))[0].filename;
  const wrapperMetadata = { ...require('./package.json'), optionalDependencies: { [packageName]: `file:${path.join(tarballs, nativeTar).replaceAll('\\', '/')}` } };
  fs.writeFileSync(path.join(wrapper, 'package.json'), JSON.stringify(wrapperMetadata));
  fs.copyFileSync(path.join(__dirname, 'install.cjs'), path.join(wrapper, 'install.cjs'));
  for (const name of ['holycodex', 'codex']) fs.writeFileSync(path.join(wrapper, 'bin', `${name}.exe`), '');
  const wrapperTar = JSON.parse(npm(['pack', wrapper, '--json', '--pack-destination', tarballs]))[0].filename;
  for (const ignoreScripts of [false, true]) {
    const consumer = path.join(root, ignoreScripts ? 'ignored' : 'consumer');
    fs.mkdirSync(consumer);
    fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true}');
    npm(['install', path.join(tarballs, wrapperTar), '--offline', '--no-audit', '--no-fund', ...(ignoreScripts ? ['--ignore-scripts'] : [])], consumer);
    for (const name of ['holycodex', 'codex']) {
      const installed = path.join(consumer, 'node_modules/holycodex/bin', `${name}.exe`);
      if (ignoreScripts) { assert.equal(fs.statSync(installed).size, 0); continue; }
      assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(executable));
      const runtimeEnv = { ...process.env };
      for (const key of Object.keys(runtimeEnv)) if (key.toLowerCase() === 'path') delete runtimeEnv[key];
      runtimeEnv.PATH = '';
      assert.equal(runtimeEnv.PATH, '');
      const launch = spawnSync(installed, [], { encoding: 'utf8', env: runtimeEnv, cwd: consumer });
      assert.equal(launch.status, 0, launch.error?.message || launch.stderr);
      assert.equal(launch.stdout.trim(), 'holycodex native install fixture');
      const link = path.join(consumer, 'node_modules/.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
      assert.ok(fs.existsSync(link));
      if (process.platform === 'win32') assert.doesNotMatch(fs.readFileSync(link, 'utf8'), /node(?:\.exe)?[" ]/i);
      const linkedLaunch = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec, ['/d', '/s', '/c', `""${link}""`], { windowsVerbatimArguments: true, encoding: 'utf8', env: runtimeEnv, cwd: consumer })
        : spawnSync(link, [], { encoding: 'utf8', env: runtimeEnv, cwd: consumer });
      assert.equal(linkedLaunch.status, 0, linkedLaunch.error?.message || linkedLaunch.stderr);
      assert.equal(linkedLaunch.stdout.trim(), 'holycodex native install fixture');
    }
  }
});
