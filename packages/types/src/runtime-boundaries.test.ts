import assert from 'node:assert/strict';
import { test } from 'bun:test';

import { createJsonEngine, decodeUtf8, encodeUtf8, exactArrayBuffer } from './index.js';

test('shared runtime helpers are available from the package facade', async () => {
  const text = 'Rustra 한글 🚀';
  assert.equal(decodeUtf8(encodeUtf8(text)), text);

  const view = new Uint8Array([1, 2, 3]).subarray(1);
  assert.deepEqual(Array.from(new Uint8Array(exactArrayBuffer(view))), [2, 3]);

  const engine = createJsonEngine(async () => ({ ok: true }));
  assert.deepEqual(await engine.invoke('health'), { ok: true });
});
