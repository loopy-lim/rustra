import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus, release, totalmem } from 'node:os';
import { pathToFileURL } from 'node:url';
// Compare two built node-binary-framing modules in separate, alternating
// processes. Samples are per feed batch (framesPerSample), not invocation p95.
const [modulePath, output] = process.argv.slice(2);
if (!modulePath || !output)
  throw new Error(
    'Usage: node scripts/node-framing-bench.mjs <built-framing-module> <receipt.json>',
  );
const { createBinaryFrameAccumulator } = await import(pathToFileURL(modulePath));
const results = [];
for (const [name, size, chunkSize, repeats] of [
  ['32b-contiguous', 32, 36, 1],
  ['32b-coalesced-100', 32, 3600, 100],
  ['64k-in-4k', 65536, 4096, 1],
  ['1m-in-4k', 1048576, 4096, 1],
  ['1m-in-64k', 1048576, 65536, 1],
  ['1m-contiguous', 1048576, 1048580, 1],
]) {
  const body = Buffer.alloc(size, 37),
    wire = Buffer.alloc(size + 4, 37);
  wire.writeUInt32LE(size);
  const input = Buffer.concat(Array.from({ length: repeats }, () => wire));
  const chunks = [];
  for (let at = 0; at < input.length; at += chunkSize)
    chunks.push(input.subarray(at, at + chunkSize));
  let delivered = 0,
    last;
  const feed = createBinaryFrameAccumulator((_cmd, bytes) => {
    delivered++;
    last = bytes;
  });
  const once = () => {
    for (const chunk of chunks) feed(chunk);
  };
  once();
  if (delivered !== repeats || !Buffer.from(last).equals(body)) throw Error(name + ' corrupt');
  const original = Buffer.concat;
  let copiedBytes = 0,
    concatenations = 0;
  Buffer.concat = (parts, ...args) => {
    copiedBytes += parts.reduce((n, v) => n + v.length, 0);
    concatenations++;
    return original(parts, ...args);
  };
  try {
    once();
  } finally {
    Buffer.concat = original;
  }
  for (let i = 0; i < 30; i++) once();
  const samplesNs = [];
  for (let i = 0; i < 200; i++) {
    const start = process.hrtime.bigint();
    once();
    samplesNs.push(Number(process.hrtime.bigint() - start));
  }
  if (delivered !== 232 * repeats || !Buffer.from(last).equals(body))
    throw Error(name + ' invalid deliveries');
  results.push({
    name,
    payloadBytes: size,
    chunkBytes: chunkSize,
    framesPerSample: repeats,
    copiedBytes,
    concatenations,
    samplesNs,
    correctness: true,
  });
}
writeFileSync(
  output,
  JSON.stringify({
    pid: process.pid,
    node: process.version,
    cpu: cpus()[0].model,
    os: release(),
    arch: process.arch,
    memory: totalmem(),
    moduleSha256: createHash('sha256').update(readFileSync(modulePath)).digest('hex'),
    results,
  }),
);
