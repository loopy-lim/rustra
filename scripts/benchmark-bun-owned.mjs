#!/usr/bin/env bun
// One independent process: the real Bun adapter and native calculator echo.
// The caller runs baseline/candidate in alternating pairs; no build occurs here.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { cpus, release, totalmem } from 'node:os';

const [adapterPath, libraryPath, outputPath, label] = process.argv.slice(2);
if (!adapterPath || !libraryPath || !outputPath || !label) {
  throw new Error(
    'Usage: bun scripts/benchmark-bun-owned.mjs <adapter.ts> <library> <receipt.json> <label>',
  );
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const library = resolve(libraryPath);
const codecPath = fileURLToPath(
  new URL('../examples/calculator/generated/frame-registry.ts', import.meta.url),
);
const modules = (directory) =>
  Object.fromEntries(
    readdirSync(directory)
      .filter((name) => /\.(ts|js)$/.test(name) && !/\.(test|d)\.(ts|js)$/.test(name))
      .sort()
      .map((name) => [name, sha256(readFileSync(join(directory, name)))]),
  );
const snapshot = () => ({
  nativeSha256: sha256(readFileSync(library)),
  codecs: modules(dirname(codecPath)),
  adapter: modules(dirname(resolve(adapterPath))),
  types: modules(dirname(fileURLToPath(import.meta.resolve('@rustra/types')))),
});
const producerBefore = snapshot();
const { createBunFfiEngine } = await import(pathToFileURL(resolve(adapterPath)).href);
const { frameRegistry } = await import(pathToFileURL(codecPath).href);
const runtime = await createBunFfiEngine({ library, frameCodecs: frameRegistry });
const sizes = [64, 501, 502, 503, 64 * 1024, 256 * 1024];
const warmup = 50;
const iterations = 500;
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const cases = [];
try {
  for (const size of sizes) {
    const input = Uint8Array.from({ length: size }, (_, index) => index % 251);
    const expected = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    const samplesUs = [];
    for (let index = -warmup; index < iterations; index++) {
      const start = performance.now();
      const result = await runtime.engine.invoke('benchEchoBytes', { data: input });
      const elapsedUs = (performance.now() - start) * 1000;
      const bytes = result.data;
      assert.ok(bytes instanceof Uint8Array, 'echo must return owned bytes');
      assert.equal(
        Buffer.compare(expected, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)),
        0,
      );
      if (index >= 0) samplesUs.push(elapsedUs);
    }
    assert.ok(samplesUs.every((sample) => Number.isFinite(sample) && sample > 0));
    cases.push({
      inputBytes: size,
      inputSha256: sha256(input),
      p50Us: percentile(samplesUs, 0.5),
      p95Us: percentile(samplesUs, 0.95),
      samplesUs,
    });
  }
} finally {
  runtime.close();
}
const producerAfter = snapshot();
assert.deepEqual(producerAfter, producerBefore, 'benchmark producer changed during measurement');
writeFileSync(
  outputPath,
  JSON.stringify(
    {
      schemaVersion: 1,
      label,
      generatedAt: new Date().toISOString(),
      runtime: `Bun ${Bun.version}`,
      platform: process.platform,
      architecture: process.arch,
      cpu: cpus()[0]?.model,
      os: release(),
      memoryBytes: totalmem(),
      producerBefore,
      producerAfter,
      producerStable: true,
      adapterPath: resolve(adapterPath),
      adapterSha256: sha256(readFileSync(adapterPath)),
      library,
      nativeSha256: sha256(readFileSync(library)),
      codecSha256: sha256(
        readFileSync(new URL('../examples/calculator/generated/frame-codecs.ts', import.meta.url)),
      ),
      measurement:
        'Bun FFI Frame engine invoke benchEchoBytes; encode, native call, decode and Promise included',
      validation: 'every response byte compared outside the timed region',
      warmup,
      iterations,
      normalization: 'none',
      cases,
    },
    null,
    2,
  ) + '\n',
  { flag: 'wx' },
);
