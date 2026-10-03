'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function packageFor(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'holycodex-native-linux-x64-gnu';
  if (platform === 'darwin' && arch === 'arm64') return 'holycodex-native-darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return 'holycodex-native-win32-x64';
  return undefined;
}

function install(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const root = options.root || __dirname;
  const resolvePackage = options.resolvePackage || ((name) => require.resolve(`${name}/package.json`, { paths: [root] }));
  const packageName = packageFor(platform, arch);
  if (!packageName) {
    throw new Error(`HolyCodex has no native npm package for ${platform}-${arch}. Supported targets: linux-x64 (GNU), darwin-arm64, win32-x64.`);
  }
  if (platform === 'linux') {
    const libc = options.libc || (process.report?.getReport?.().header?.glibcVersionRuntime ? 'glibc' : undefined);
    if (libc !== 'glibc') throw new Error('HolyCodex currently supports Linux x64 with glibc only; musl builds are not available.');
  }

  let binaryRoot;
  try {
    binaryRoot = path.dirname(resolvePackage(packageName));
  } catch (error) {
    throw new Error(`Could not find optional dependency ${packageName}; reinstall holycodex with optional dependencies enabled.`, { cause: error });
  }

  const extension = platform === 'win32' ? '.exe' : '';
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const metadata = JSON.parse(fs.readFileSync(path.join(binaryRoot, 'package.json'), 'utf8'));
  const integrity = JSON.parse(fs.readFileSync(path.join(binaryRoot, 'payload.json'), 'utf8'));
  if (metadata.name !== packageName || metadata.version !== version
      || integrity.format !== 1 || integrity.package !== packageName || integrity.version !== version
      || !/^[a-f0-9]{64}$/.test(integrity.sha256 || '')) {
    throw new Error('HolyCodex native package identity or integrity metadata is invalid.');
  }
  // Validate both payloads before replacing any npm link targets. npm's own
  // tarball integrity supplies package authenticity; this digest checks the
  // installed payload against its build manifest and catches alias mismatch.
  const payloads = ['holycodex', 'codex'].map((name) => {
    const source = path.join(binaryRoot, 'bin', `${name}${extension}`);
    if (!fs.lstatSync(source).isFile()) throw new Error(`Native executable is missing: ${source}`);
    const bytes = fs.readFileSync(source);
    if (!bytes.length || createHash('sha256').update(bytes).digest('hex') !== integrity.sha256) {
      throw new Error(`HolyCodex native payload checksum mismatch: ${source}`);
    }
    return bytes;
  });
  if (!payloads[0].equals(payloads[1])) throw new Error('HolyCodex native aliases differ.');
  const destinationDir = path.join(root, 'bin');
  fs.mkdirSync(destinationDir, { recursive: true });
  const destinations = ['holycodex', 'codex'].map((name) => path.join(destinationDir, `${name}.exe`));
  const temporary = destinations.map((destination) => `${destination}.${process.pid}.tmp`);
  const created = [];
  try {
    for (let i = 0; i < temporary.length; i++) {
      fs.writeFileSync(temporary[i], payloads[i], { flag: 'wx', mode: 0o755 });
      created.push(temporary[i]);
      if (platform !== 'win32') fs.chmodSync(temporary[i], 0o755);
    }
    // The fixed .exe suffix makes npm's bin mapping portable. Unix executes
    // ELF/Mach-O by contents; npm's Windows shims directly invoke the PE file.
    for (let i = 0; i < temporary.length; i++) fs.renameSync(temporary[i], destinations[i]);
  } finally {
    for (const filename of created) fs.rmSync(filename, { force: true });
  }
}

if (require.main === module) install();

module.exports = { install, packageFor };
