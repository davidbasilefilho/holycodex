'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function packageFor(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return '@turndev/holycodex-native-linux-x64-gnu';
  if (platform === 'darwin' && arch === 'arm64') return '@turndev/holycodex-native-darwin-arm64';
  if (platform === 'win32' && arch === 'x64') return '@turndev/holycodex-native-win32-x64';
  return undefined;
}

function readPayloadManifest(filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const match = /^format = ([1-9][0-9]*)\npackage = "([^"\r\n]+)"\nversion = "([^"\r\n]+)"\nsha256 = "([a-f0-9]{64})"\n?$/.exec(source);
  if (!match) throw new Error('HolyCodex native payload TOML is invalid.');
  return { format: Number(match[1]), package: match[2], version: match[3], sha256: match[4] };
}

// The allowlist is versioned with the pinned upstream layout. Never trust
// archive-provided paths: they would otherwise become installer write targets.
const resourcePolicy = require('./native-inventory.json');
function readResourceInventory(root, target) {
  const spec = resourcePolicy.targets[target];
  if (!spec) throw new Error('unsupported native resource target');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'native-inventory.json'), 'utf8'));
  const expected = [...spec.files, 'codex-package.json'].sort();
  if (manifest.format !== 1 || manifest.target !== target
      || manifest.upstreamCommit !== resourcePolicy.upstreamCommit
      || JSON.stringify(Object.keys(manifest.files || {}).sort()) !== JSON.stringify(expected)) {
    throw new Error('invalid native resource inventory or upstream provenance');
  }
  const payloads = expected.map((relative) => {
    const proof = manifest.files[relative];
    if (!/^[a-f0-9]{64}$/.test(proof.sha256) || !Number.isSafeInteger(proof.bytes) || proof.bytes <= 0) {
      throw new Error('invalid native resource integrity metadata');
    }
    const source = path.join(root, relative);
    for (let current = source; current !== root; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`native resource traverses symlink: ${relative}`);
    }
    if (!fs.lstatSync(source).isFile()) throw new Error(`missing native resource: ${relative}`);
    const bytes = fs.readFileSync(source);
    if (bytes.length !== proof.bytes || createHash('sha256').update(bytes).digest('hex') !== proof.sha256) {
      throw new Error(`native resource checksum mismatch: ${relative}`);
    }
    return { relative, bytes };
  });
  const layout = JSON.parse(payloads.find((entry) => entry.relative === 'codex-package.json').bytes);
  const extension = target === 'win32-x64' ? '.exe' : '';
  if (layout.layoutVersion !== 1 || layout.target !== spec.triple || layout.variant !== 'codex'
      || layout.entrypoint !== `bin/codex${extension}` || layout.resourcesDir !== 'codex-resources'
      || layout.pathDir !== 'codex-path' || layout.version !== '0.17.0') {
    throw new Error('invalid native resource runtime layout');
  }
  return payloads;
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
  const integrity = readPayloadManifest(path.join(binaryRoot, 'payload.toml'));
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
  const target = packageName.replace('@turndev/holycodex-native-', '');
  const resources = readResourceInventory(binaryRoot, target);
  const destinationDir = path.join(root, 'bin');
  fs.mkdirSync(destinationDir, { recursive: true });
  // Preserve the canonical Unix entrypoint required by daemon package validation
  // in addition to npm's cross-platform .exe link targets.
  const canonical = platform === 'win32' ? [] : ['holycodex', 'codex'].map((name, index) => ({ relative: `bin/${name}`, bytes: payloads[index] }));
  resources.push(...canonical);
  const destinations = [
    ...['holycodex', 'codex'].map((name) => path.join(destinationDir, `${name}.exe`)),
    ...resources.map(({ relative }) => path.join(root, relative)),
  ];
  payloads.push(...resources.map(({ bytes }) => bytes));
  const stagingDir = fs.mkdtempSync(path.join(destinationDir, '.holycodex-install-'));
  const temporary = destinations.map((_, index) => path.join(stagingDir, String(index)));
  const backups = destinations.map((_, index) => path.join(stagingDir, `${index}.bak`));
  const hadOriginal = [];
  const replaced = [];
  let preserveBackups = false;
  try {
    for (let i = 0; i < temporary.length; i++) {
      const parent = path.dirname(destinations[i]);
      let current = root;
      for (const part of path.relative(root, parent).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        try { fs.mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (!fs.lstatSync(current).isDirectory()) throw new Error(`native destination is not a directory: ${current}`);
      }
      fs.writeFileSync(temporary[i], payloads[i], { flag: 'wx', mode: 0o755 });
      if (platform !== 'win32') fs.chmodSync(temporary[i], 0o755);
      let original;
      try {
        original = fs.lstatSync(destinations[i]);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      hadOriginal[i] = Boolean(original);
      if (original) {
        if (!original.isFile()) throw new Error(`Native executable destination is not a regular file: ${destinations[i]}`);
        fs.copyFileSync(destinations[i], backups[i], fs.constants.COPYFILE_EXCL);
        if (platform !== 'win32') fs.chmodSync(backups[i], original.mode & 0o7777);
      }
    }
    // The fixed .exe suffix makes npm's bin mapping portable. Unix executes
    // ELF/Mach-O by contents; npm's Windows shims directly invoke the PE file.
    // Keep both originals until both aliases are installed. In particular, a
    // locked Windows executable must not leave the other alias upgraded.
    for (let i = 0; i < temporary.length; i++) {
      fs.renameSync(temporary[i], destinations[i]);
      replaced.push(i);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const i of replaced.reverse()) {
      try {
        if (hadOriginal[i]) fs.renameSync(backups[i], destinations[i]);
        else fs.rmSync(destinations[i]);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length) {
      preserveBackups = true;
      throw new AggregateError([error, ...rollbackErrors], `HolyCodex installation failed and rollback was incomplete; recovery files remain in ${stagingDir}.`, { cause: error });
    }
    throw error;
  } finally {
    if (!preserveBackups) fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

if (require.main === module) install();

module.exports = { install, packageFor, readPayloadManifest, readResourceInventory, resourcePolicy };
