'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

// git ls-remote emits both the tag object and ^{} commit for annotated tags.
// Compare the peeled commit when available; never equate tag-object identity
// or main ancestry with the current accepted source.
function verifySelectedRef(output, ref, expectedSha) {
  assert.ok(ref === 'refs/heads/next' || ref === 'refs/tags/v0.17.0', 'unsupported publication ref');
  assert.match(expectedSha, /^[a-f0-9]{40}$/);
  const records = new Map();
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]{40})\s+(\S+)$/.exec(line);
    assert.ok(match, 'invalid remote ref response');
    assert.ok(match[2] === ref || (ref.startsWith('refs/tags/') && match[2] === `${ref}^{}`), 'unexpected remote ref');
    assert.ok(!records.has(match[2]), 'duplicate remote ref');
    records.set(match[2], match[1]);
  }
  assert.ok(records.has(ref), 'accepted remote ref is missing');
  assert.equal(records.get(`${ref}^{}`) || records.get(ref), expectedSha,
    'accepted remote ref moved away from validated source');
}

if (require.main === module) {
  const [filename, ref, sha] = process.argv.slice(2);
  verifySelectedRef(fs.readFileSync(filename, 'utf8'), ref, sha);
}

module.exports = { verifySelectedRef };
