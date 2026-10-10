'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { PLATFORM_PACKAGES, validateVersion, tarballName } = require('./channel.cjs');
const { TARGETS, expectedRuntimeVersion, verifyNativeHeader } = require('./native-smoke.cjs');
const { MAX_NATIVE_BYTES, verifyArchiveSize } = require('./verify-release.cjs');

function npmCli() {
  // npm can be installed independently of Node (for example through mise).
  // Falling back to Node's bundled copy would silently test a different client.
  const selected = process.env.npm_execpath;
  assert.ok(selected && path.basename(selected) === 'npm-cli.js' && fs.existsSync(selected),
    'Run this gate through npm exec --offline --call "node ..." so it tests the selected npm CLI.');
  assert.ok(fs.statSync(selected).isFile(), 'selected npm CLI must be a file');
  return selected;
}

function installArguments(wrapper, native, prefix, npmVersion) {
  assert.match(npmVersion, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'invalid npm version');
  const approvalsRequired = Number(npmVersion.split('.')[0]) >= 12;
  // npm parses this option as a comma-separated source list. Refuse ambiguous
  // paths rather than accidentally approve a different source.
  if (approvalsRequired) assert.ok(!wrapper.includes(','), 'npm script approval requires a wrapper path without commas');
  return ['install', '--global', '--prefix', prefix, '--offline', '--no-audit', '--no-fund',
    '--foreground-scripts', '--include=optional',
    // npm 12 blocks unapproved dependency scripts. Its per-command allowlist
    // is supported for global installs only; never persist or blanket-enable it.
    // Local archives match by exact source, not their self-reported package name.
    ...(approvalsRequired ? [`--allow-scripts=file:${wrapper.replaceAll('\\', '/')}`, '--strict-allow-scripts'] : []),
    native, wrapper];
}

function isolatedEnvironment(root, source = process.env) {
  // Do not pass real Codex/npm homes, authentication, Node preload options, or
  // user npm configuration into a package lifecycle or runtime smoke process.
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^(path|systemroot|windir|systemdrive|comspec|pathext)$/i.test(key)) env[key] = value;
  }
  Object.assign(env, { HOME: root, USERPROFILE: root, CODEX_HOME: path.join(root, 'codex-home'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'localappdata'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'), XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'xdg-data'), TMPDIR: root, TEMP: root, TMP: root,
    CI: 'true', NO_COLOR: '1', TERM: 'dumb',
    npm_config_cache: path.join(root, 'cache'), npm_config_userconfig: path.join(root, 'npmrc'),
    npm_config_globalconfig: path.join(root, 'global-npmrc'), npm_config_update_notifier: 'false' });
  return env;
}

function archiveMember(archive, name) {
  return execFileSync('tar', ['-xzOf', `./${path.basename(archive)}`, `package/${name}`], {
    cwd: path.dirname(archive), timeout: 120_000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function verifyInstalledFiles(filenames, digest, target) {
  const readers = [];
  try {
    for (const filename of filenames) {
      const stat = fs.lstatSync(filename);
      assert.ok(stat.isFile() && stat.size > 0 && stat.size <= MAX_NATIVE_BYTES,
        `${filename}: missing native payload; postinstall may have been blocked or skipped`);
      verifyNativeHeader(filename, target);
      if (process.platform !== 'win32') assert.ok(stat.mode & 0o111, `${filename}: native payload is not executable`);
      readers.push(fs.openSync(filename, 'r'));
    }
    const chunks = readers.map(() => Buffer.alloc(64 * 1024));
    const hash = createHash('sha256');
    let bytes = 0;
    while (true) {
      const counts = readers.map((reader, index) => fs.readSync(reader, chunks[index], 0, chunks[index].length, null));
      for (let index = 1; index < readers.length; index++) {
        assert.equal(counts[index], counts[0], 'installed native and wrapper aliases differ');
        assert.ok(chunks[index].subarray(0, counts[index]).equals(chunks[0].subarray(0, counts[0])),
          'installed native and wrapper aliases differ');
      }
      if (!counts[0]) break;
      hash.update(chunks[0].subarray(0, counts[0]));
      bytes += counts[0];
    }
    assert.equal(hash.digest('hex'), digest, 'installed payload does not match the exact native archive digest');
    return bytes;
  } finally {
    for (const reader of readers) fs.closeSync(reader);
  }
}

function smokeInstallation(wrapperArchive, nativeArchive, target, version, options = {}) {
  validateVersion(version);
  assert.ok(Object.hasOwn(TARGETS, target), 'unsupported installation target');
  const host = TARGETS[target];
  assert.equal(process.platform, host.platform, 'installation smoke must run on its advertised OS');
  assert.equal(process.arch, host.arch, 'installation smoke must run on its advertised architecture');
  if (host.platform === 'linux') assert.ok(process.report.getReport().header.glibcVersionRuntime, 'installation smoke requires glibc');
  const wrapper = path.resolve(wrapperArchive);
  const native = path.resolve(nativeArchive);
  const packageName = `@turndev/holycodex-native-${target}`;
  for (const [archive, name] of [[wrapper, 'holycodex'], [native, packageName]]) {
    verifyArchiveSize(archive);
    assert.equal(path.basename(archive), tarballName(name, version), 'installation tarball name mismatch');
  }
  const wrapperMetadata = JSON.parse(archiveMember(wrapper, 'package.json'));
  const nativeMetadata = JSON.parse(archiveMember(native, 'package.json'));
  for (const [metadata, name] of [[wrapperMetadata, 'holycodex'], [nativeMetadata, packageName]]) {
    assert.equal(metadata.name, name, 'installation package identity mismatch');
    assert.equal(metadata.version, version, 'installation distribution version mismatch');
  }
  for (const field of ['os', 'cpu', 'libc']) assert.deepEqual(nativeMetadata[field], host[field], `native ${field} metadata mismatch`);
  assert.deepEqual(wrapperMetadata.optionalDependencies, Object.fromEntries(PLATFORM_PACKAGES.map((name) => [name, version])),
    'wrapper must retain exact release optional dependencies');
  assert.deepEqual(wrapperMetadata.bin, { holycodex: 'bin/holycodex.exe', codex: 'bin/codex.exe' });
  assert.equal(wrapperMetadata.scripts?.postinstall, 'node install.cjs', 'wrapper postinstall contract changed');
  for (const hook of ['preinstall', 'install', 'prepare']) assert.equal(wrapperMetadata.scripts?.[hook], undefined, 'unexpected wrapper lifecycle');
  assert.deepEqual(nativeMetadata.scripts || {}, {}, 'native package must not run install scripts');
  for (const alias of ['holycodex', 'codex']) {
    assert.equal(archiveMember(wrapper, `bin/${alias}.exe`).length, 0, 'wrapper must start with empty link placeholders');
  }
  const manifest = archiveMember(native, 'payload.toml');
  const proof = /^format = 1\npackage = "([^"\r\n]+)"\nversion = "([^"\r\n]+)"\nsha256 = "([a-f0-9]{64})"\n?$/.exec(manifest.toString('utf8'));
  assert.ok(proof, 'invalid native payload manifest');
  assert.equal(proof[1], packageName, 'payload package identity mismatch');
  assert.equal(proof[2], version, 'payload distribution version mismatch');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-installation-smoke-'));
  const run = options.run || execFileSync;
  try {
    const env = isolatedEnvironment(temporary);
    for (const directory of ['CODEX_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'npm_config_cache']) {
      fs.mkdirSync(env[directory], { mode: 0o700 });
    }
    fs.writeFileSync(env.npm_config_userconfig, '');
    fs.writeFileSync(env.npm_config_globalconfig, '');
    const prefix = path.join(temporary, 'prefix');
    const modules = path.join(prefix, ...(host.platform === 'win32' ? [] : ['lib']), 'node_modules');
    // npm's strict approval preflight inspects the global tree before reify.
    fs.mkdirSync(modules, { recursive: true, mode: 0o700 });
    const cli = options.npmCli || npmCli();
    const subprocess = { cwd: temporary, env, encoding: 'utf8', timeout: 30_000,
      maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] };
    const npmVersion = run(process.execPath, [cli, '--version'], subprocess).trim();
    // Both unmodified archives are direct inputs. The wrapper resolves its exact
    // optional dependency from the same isolated global tree, entirely offline.
    run(process.execPath, [cli, ...installArguments(wrapper, native, prefix, npmVersion)],
      { ...subprocess, timeout: 180_000 });
    const installedWrapper = path.join(modules, 'holycodex');
    const installedNative = path.join(modules, ...packageName.split('/'));
    for (const [directory, metadata] of [[installedWrapper, wrapperMetadata], [installedNative, nativeMetadata]]) {
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')), metadata, 'installed metadata differs from the archive');
    }
    assert.ok(fs.readFileSync(path.join(installedNative, 'payload.toml')).equals(manifest), 'installed manifest differs from the archive');
    const nativeExtension = host.platform === 'win32' ? '.exe' : '';
    const executables = ['holycodex', 'codex'].map((alias) => path.join(installedWrapper, 'bin', `${alias}.exe`));
    const nativeBytes = verifyInstalledFiles([
      ...['holycodex', 'codex'].map((alias) => path.join(installedNative, 'bin', alias + nativeExtension)),
      ...executables,
    ], proof[3], target);

    const runtimeEnv = { ...env };
    for (const key of Object.keys(runtimeEnv)) if (key.toLowerCase() === 'path') delete runtimeEnv[key];
    runtimeEnv.PATH = '';
    const runtimeOptions = { ...subprocess, env: runtimeEnv };
    const runtimeVersion = expectedRuntimeVersion();
    const binDirectory = host.platform === 'win32' ? prefix : path.join(prefix, 'bin');
    function checkLaunch(filename, args, launchOptions, argument) {
      const output = run(filename, args, launchOptions);
      if (argument === '--version') assert.equal(output.trim(), runtimeVersion, 'installed runtime identity/version mismatch');
      else {
        assert.match(output, /HolyCodex CLI/, 'installed executable is missing native CLI identity');
        assert.match(output, /Usage: holycodex /, 'installed executable has the wrong CLI entrypoint');
      }
    }
    for (const [index, alias] of ['holycodex', 'codex'].entries()) {
      const link = path.join(binDirectory, alias + (host.platform === 'win32' ? '.cmd' : ''));
      assert.ok(fs.existsSync(link), `npm did not create the ${alias} command`);
      if (host.platform === 'win32') assert.doesNotMatch(fs.readFileSync(link, 'utf8'), /node(?:\.exe)?[" ]/i, 'npm command unexpectedly depends on Node');
      else assert.equal(fs.realpathSync(link), fs.realpathSync(executables[index]), 'npm command targets the wrong executable');
      for (const argument of ['--version', '--help']) {
        checkLaunch(executables[index], [argument], runtimeOptions, argument);
        if (host.platform === 'win32') {
          const comspec = Object.entries(env).find(([key]) => key.toLowerCase() === 'comspec')?.[1];
          assert.ok(comspec && path.isAbsolute(comspec), 'Windows smoke requires an absolute ComSpec');
          // Only fixed command/argument strings reach cmd.exe. Avoid interpolating
          // a temporary path containing cmd metacharacters into the command line.
          checkLaunch(comspec, ['/d', '/s', '/c', `${alias}.cmd ${argument}`],
            { ...runtimeOptions, cwd: binDirectory, windowsVerbatimArguments: true }, argument);
        } else checkLaunch(link, [argument], runtimeOptions, argument);
      }
    }
    return { target, distributionVersion: version, runtimeVersion, nodeVersion: process.version, npmVersion,
      installMode: 'isolated-global-offline', postinstallVerified: true, runtimePath: '',
      aliases: ['holycodex', 'codex'], nativeBytes, payloadSha256: proof[3] };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (require.main === module) {
  const [wrapper, native, target, version] = process.argv.slice(2);
  assert.equal(process.argv.length, 6, 'usage: node installation-smoke.cjs WRAPPER_TARBALL NATIVE_TARBALL TARGET DISTRIBUTION_VERSION');
  console.log(JSON.stringify(smokeInstallation(wrapper, native, target, version)));
}

module.exports = { smokeInstallation, installArguments, isolatedEnvironment, verifyInstalledFiles, npmCli };
