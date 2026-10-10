'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { BASE_VERSION, validateVersion, tarballName } = require('./channel.cjs');
const { verifyNativeAliases, verifyArchiveSize, tarFile } = require('./verify-release.cjs');

const TARGETS = {
  'linux-x64-gnu': { platform: 'linux', arch: 'x64', os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', os: ['darwin'], cpu: ['arm64'] },
  'win32-x64': { platform: 'win32', arch: 'x64', os: ['win32'], cpu: ['x64'] },
};

function expectedRuntimeVersion() {
  const pin = fs.readFileSync(path.join(__dirname, '../../upstream.toml'), 'utf8');
  const version = /^holycodex_version = "([^"\r\n]+)"$/m.exec(pin)?.[1];
  const upstream = /^release = "rust-v([0-9]+\.[0-9]+\.[0-9]+)"$/m.exec(pin)?.[1];
  assert.equal(version, BASE_VERSION, 'runtime version must match the authoritative pin');
  assert.ok(upstream, 'missing pinned upstream release identity');
  // DEV changes npm metadata only; the native runtime keeps its pinned version.
  return `holycodex ${version} (Codex upstream ${upstream})`;
}

function verifyNativeHeader(filename, target) {
  const header = Buffer.alloc(64);
  const fd = fs.openSync(filename, 'r');
  try {
    assert.equal(fs.readSync(fd, header, 0, header.length, 0), header.length,
      'native executable header is truncated');
    if (target === 'linux-x64-gnu') {
      assert.equal(header.subarray(0, 4).toString('hex'), '7f454c46', 'expected a native ELF executable');
      assert.equal(header[4], 2, 'expected 64-bit ELF');
      assert.equal(header[5], 1, 'expected little-endian ELF');
      assert.equal(header.readUInt16LE(18), 62, 'expected x64 ELF');
    } else if (target === 'darwin-arm64') {
      assert.equal(header.readUInt32LE(0), 0xfeedfacf, 'expected a native 64-bit Mach-O executable');
      assert.equal(header.readUInt32LE(4), 0x0100000c, 'expected arm64 Mach-O');
    } else if (target === 'win32-x64') {
      assert.equal(header.subarray(0, 2).toString(), 'MZ', 'expected a native PE executable');
      const pe = Buffer.alloc(6);
      assert.equal(fs.readSync(fd, pe, 0, pe.length, header.readUInt32LE(60)), pe.length,
        'PE executable header is truncated');
      assert.equal(pe.subarray(0, 4).toString('hex'), '50450000', 'expected a PE signature');
      assert.equal(pe.readUInt16LE(4), 0x8664, 'expected x64 PE');
    } else throw new Error('unsupported native target');
  } finally {
    fs.closeSync(fd);
  }
}

function smokeNative(archive, target, version, run = execFileSync) {
  validateVersion(version);
  assert.ok(Object.hasOwn(TARGETS, target), 'unsupported native target');
  const host = TARGETS[target];
  assert.equal(process.platform, host.platform, 'native smoke must run on its advertised OS');
  assert.equal(process.arch, host.arch, 'native smoke must run on its advertised architecture');
  if (host.platform === 'linux') {
    assert.ok(process.report.getReport().header.glibcVersionRuntime, 'native smoke requires glibc');
  }
  const compressedBytes = verifyArchiveSize(archive);
  const metadata = JSON.parse(tarFile(archive, 'package.json'));
  const packageName = `@turndev/holycodex-native-${target}`;
  assert.equal(metadata.name, packageName, 'native package identity mismatch');
  assert.equal(metadata.version, version, 'native distribution version mismatch');
  assert.equal(path.basename(archive), tarballName(packageName, version), 'native tarball name mismatch');
  for (const field of ['os', 'cpu', 'libc']) {
    assert.deepEqual(metadata[field], host[field], `native ${field} metadata mismatch`);
  }
  const proof = /^format = 1\npackage = "([^"\r\n]+)"\nversion = "([^"\r\n]+)"\nsha256 = "([a-f0-9]{64})"\n?$/.exec(tarFile(archive, 'payload.toml').toString('utf8'));
  assert.ok(proof, 'invalid native payload manifest');
  assert.equal(proof[1], packageName, 'payload package identity mismatch');
  assert.equal(proof[2], version, 'payload distribution version mismatch');

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'holycodex-runtime-smoke-'));
  try {
    const home = path.join(temporary, 'codex-home');
    fs.mkdirSync(home, { mode: 0o700 });
    const env = { ...process.env, CODEX_HOME: home, HOME: temporary, USERPROFILE: temporary };
    const expected = expectedRuntimeVersion();
    const extension = host.platform === 'win32' ? '.exe' : '';
    const nativeBytes = verifyNativeAliases(archive, extension, proof[3], archive, (filenames) => {
      for (const filename of filenames) {
        verifyNativeHeader(filename, target);
        if (host.platform !== 'win32') fs.chmodSync(filename, 0o700);
        const options = { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'], cwd: temporary, env };
        assert.equal(run(filename, ['--version'], options).trim(), expected,
          `${path.basename(filename)}: runtime identity/version mismatch`);
        const help = run(filename, ['--help'], options);
        assert.match(help, /HolyCodex CLI/, `${path.basename(filename)}: missing native CLI identity`);
        assert.match(help, /Usage: holycodex /, `${path.basename(filename)}: wrong CLI entrypoint`);
      }
    });
    return { target, distributionVersion: version, runtimeVersion: expected, compressedBytes,
      nativeBytes, payloadSha256: proof[3] };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [archive, target, version] = process.argv.slice(2);
  assert.equal(process.argv.length, 5, 'usage: node native-smoke.cjs TARBALL TARGET DISTRIBUTION_VERSION');
  console.log(JSON.stringify(smokeNative(path.resolve(archive), target, version)));
}

module.exports = { TARGETS, expectedRuntimeVersion, verifyNativeHeader, smokeNative };
