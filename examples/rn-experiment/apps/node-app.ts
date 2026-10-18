// Actual generated consumer: a schema generator is not an invoke executable.
import assert from 'node:assert/strict';
import { gzipCompress, gzipDecompress, rustra, uuidV7 } from '../generated/node.js';
import { asBytes, pseudoRandomPayload } from './benchmark.js';

try {
  await rustra.ready();
  const input = pseudoRandomPayload(64 * 1024);
  const compressed = asBytes((await gzipCompress({ data: Array.from(input) })).data);
  const restored = asBytes((await gzipDecompress({ data: Array.from(compressed) })).data);
  assert.deepEqual(restored, input);
  assert.ok(compressed.length < input.length);
  assert.match(
    (await uuidV7({})).value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  await assert.rejects(gzipDecompress({ data: [1, 2, 3] }), { code: 'command.invalid_args' });
  console.log(
    'rn-experiment generated Node consumer: Rust gzip round trip, UUID and invalid input passed',
  );
} finally {
  rustra.dispose();
}
