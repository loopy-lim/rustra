import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
// Native echo timings include encode, pipes, Rust dispatch and decode. Run
// baseline and candidate adapters in separate alternating processes against the
// same Rust executable and generated registry; validation is outside the clock.
const [adapterPath, codecPath, binaryPath, output] = process.argv.slice(2);
if (!adapterPath || !codecPath || !binaryPath || !output)
  throw new Error(
    'Usage: node scripts/node-native-echo-bench.mjs <adapter-entry> <frame-registry> <runtime-binary> <receipt.json>',
  );
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const modules = (directory) =>
  Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
      .sort()
      .map((name) => [name, hash(join(directory, name))]),
  );
const snapshot = () => ({
  binarySha256: hash(binaryPath),
  codecs: modules(dirname(codecPath)),
  adapter: modules(dirname(adapterPath)),
  types: modules(dirname(fileURLToPath(import.meta.resolve('@rustra/types')))),
});
const producerBefore = snapshot();
const { createNodeLoopTransport } = await import(pathToFileURL(adapterPath));
const { frameRegistry } = await import(pathToFileURL(codecPath));
const transport = createNodeLoopTransport({ command: binaryPath, codecs: frameRegistry });
const results = [];
try {
  await transport.ready();
  for (const size of [64, 65536, 262144]) {
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 17) % 251);
    const verify = (result) => {
      if (!Buffer.from(result.data).equals(data)) throw Error('wrong response');
    };
    for (let i = 0; i < 500; i++) verify(await transport.invoke('benchEchoBytes', { data }));
    const samplesNs = [];
    for (let i = 0; i < 2000; i++) {
      const start = process.hrtime.bigint();
      const result = await transport.invoke('benchEchoBytes', { data });
      samplesNs.push(Number(process.hrtime.bigint() - start));
      verify(result);
    }
    results.push({
      payloadBytes: size,
      warmup: 500,
      iterations: 2000,
      samplesNs,
      correctness: true,
    });
  }
} finally {
  transport.dispose();
}
const producerAfter = snapshot();
if (JSON.stringify(producerBefore) !== JSON.stringify(producerAfter))
  throw new Error('Benchmark producer changed during measurement');
writeFileSync(
  output,
  JSON.stringify({
    pid: process.pid,
    node: process.version,
    binarySha256: hash(binaryPath),
    codecSha256: hash(codecPath),
    producerBefore,
    producerAfter,
    producerStable: true,
    results,
  }),
);
