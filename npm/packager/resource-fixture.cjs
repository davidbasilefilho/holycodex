// Synthetic payloads test packaging mechanics only, never native execution.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const policy = require('../holycodex/native-inventory.json');
function resourceFixture(root, target, bytes) {
  if (!bytes) {
    bytes = Buffer.alloc(128);
    if (target === 'linux-x64-gnu') {
      bytes.write('7f454c46', 0, 'hex'); bytes[4] = 2; bytes[5] = 1; bytes.writeUInt16LE(62, 18);
    } else if (target === 'darwin-arm64') {
      bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4);
    } else {
      bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('50450000', 64, 'hex'); bytes.writeUInt16LE(0x8664, 68);
    }
  }
  const spec = policy.targets[target];
  const files = {};
  const layout = Buffer.from(JSON.stringify({ layoutVersion: 1, version: '0.17.0', target: spec.triple,
    variant: 'codex', entrypoint: `bin/codex${target === 'win32-x64' ? '.exe' : ''}`,
    resourcesDir: 'codex-resources', pathDir: 'codex-path' }));
  for (const relative of [...spec.files, 'codex-package.json']) {
    const payload = relative === 'codex-package.json' ? layout : bytes;
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, payload, { mode: 0o755 });
    files[relative] = { bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
  }
  fs.writeFileSync(path.join(root, 'native-inventory.json'), JSON.stringify({ format: 1,
    upstreamCommit: policy.upstreamCommit, target, files }));
}
module.exports = { resourceFixture };
