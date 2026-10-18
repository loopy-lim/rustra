import assert from 'node:assert/strict';
import test from 'node:test';
import { createBinaryFrameAccumulator } from './node-binary-framing.js';

function wire(body: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}

test('binary reader preserves empty, short and multiple frames at every chunk boundary', () => {
  const bodies = [Buffer.alloc(0), Buffer.from([7]), Buffer.from([1, 2, 3]), Buffer.alloc(97, 43)];
  const input = Buffer.concat(bodies.map(wire));
  for (let step = 1; step <= input.length; step++) {
    const actual: Buffer[] = [];
    const commands: number[] = [];
    const feed = createBinaryFrameAccumulator((command, bytes) => {
      commands.push(command);
      actual.push(Buffer.from(bytes));
    });
    for (let at = 0; at < input.length; at += step) {
      feed(Buffer.alloc(0));
      feed(input.subarray(at, at + step));
    }
    assert.deepEqual(actual, bodies, `chunk size ${step}`);
    assert.deepEqual(commands, [-1, -1, 513, 11051]);
  }
});

test('fragmented large binary response is copied at most once', () => {
  const body = Buffer.alloc(1024 * 1024, 37);
  const input = wire(body);
  const original = Buffer.concat;
  let copiedBytes = 0;
  let frames = 0;
  // Measure actual concatenated bytes, not elapsed time, so the regression is
  // deterministic on both runtimes and on busy CI machines.
  Buffer.concat = function (list, length) {
    copiedBytes += list.reduce((sum, part) => sum + part.byteLength, 0);
    return original(list, length);
  };
  try {
    const feed = createBinaryFrameAccumulator((_command, bytes) => {
      assert.deepEqual(Buffer.from(bytes), body);
      frames++;
    });
    for (let at = 0; at < input.length; at += 4096) feed(input.subarray(at, at + 4096));
  } finally {
    Buffer.concat = original;
  }
  assert.equal(frames, 1);
  assert.ok(copiedBytes <= body.length, `copied ${copiedBytes} bytes for ${body.length} bytes`);
});

test('an incomplete untrusted length never allocates the advertised body', () => {
  const prefix = Buffer.from([255, 255, 255, 255]);
  let delivered = false;
  const original = Buffer.allocUnsafe;
  let maximumAllocation = 0;
  Buffer.allocUnsafe = function (length) {
    maximumAllocation = Math.max(maximumAllocation, length);
    return original(length);
  };
  try {
    const feed = createBinaryFrameAccumulator(() => {
      delivered = true;
    });
    for (const byte of prefix) feed(Buffer.from([byte]));
    feed(Buffer.from([1, 2, 3]));
  } finally {
    Buffer.allocUnsafe = original;
  }
  assert.equal(delivered, false);
  assert.ok(maximumAllocation <= 8, `allocated ${maximumAllocation} bytes before receiving body`);
});

test('delivered views survive later frames and fragmented headers', () => {
  const retained: Uint8Array[] = [];
  const feed = createBinaryFrameAccumulator((_command, bytes) => retained.push(bytes));
  const first = wire(Buffer.from([1, 2, 3, 4]));
  feed(first.subarray(0, 5));
  feed(first.subarray(5));
  const second = wire(Buffer.from([9, 8, 7]));
  for (const byte of second) feed(Buffer.from([byte]));
  assert.deepEqual(
    retained.map((bytes) => Array.from(bytes)),
    [
      [1, 2, 3, 4],
      [9, 8, 7],
    ],
  );
});
