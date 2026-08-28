/**
 * Track B bench — wideAgg/tagSet JS codec path cost.
 *
 * Measures the JS side of the Track B surface (the path that C++ direct
 * marshalling replaces): the calculator example's generated `wideAggCodec`
 * and `tagSetCodec`, using the same recipe as
 * `scripts/complex-codec-bench.mjs` (warmup + wall-clock, per-call
 * writer/response allocation, machine-readable JSON receipt).
 *
 * These commands have asymmetric input/output schemas, so encode is
 * measured over the PINNED-fixture request payload and decode over the
 * PINNED-fixture response body — the same corners the three-surface wire
 * gates pin (wire_fixtures.rs / cross-wire.test.ts / C++ tests).
 *
 * NOT measured here: Rust handler time, C++ JSI marshalling time, real
 * device. See docs/benchmarks.md Track B section for caveats.
 */
import { wideAggCodec, tagSetCodec } from '../examples/calculator/generated/rkyv-codecs.js';

const ITER = 20_000;
const WARMUP = 2_000;

function numericOption(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function hexToBytes(hex) {
  const u = new Uint8Array(hex.length / 2);
  for (let i = 0; i < u.length; i++) u[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return u;
}

/** Wrap a postcard body in an ok response frame ([ok=1][7 pad][body]). */
function framed(body) {
  const response = new Uint8Array(8 + body.length);
  response[0] = 1;
  response.set(body, 8);
  return response;
}

function benchEncode(name, codec, sample, iterations, warmup) {
  for (let i = 0; i < warmup; i += 1) codec.encode(sample);
  let requestBytes = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    requestBytes = codec.encode(sample).byteLength;
  }
  const us = ((performance.now() - start) * 1_000) / iterations;
  return { op: 'encode', schema: name, iterations, bytes: requestBytes, us: Number(us.toFixed(3)) };
}

function benchDecode(name, codec, response, iterations, warmup) {
  const probe = codec.decode(response.buffer);
  if (!probe.ok) throw new Error(`${name} bench decode failed: ${probe.error?.message}`);
  for (let i = 0; i < warmup; i += 1) codec.decode(response.buffer);
  let responseBytes = 0;
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const result = codec.decode(response.buffer);
    if (!result.ok) throw new Error(`${name} bench decode failed: ${result.error?.message}`);
    responseBytes = response.byteLength;
  }
  const us = ((performance.now() - start) * 1_000) / iterations;
  return { op: 'decode', schema: name, iterations, bytes: responseBytes, us: Number(us.toFixed(3)) };
}

// Same corners as the PINNED-hex fixtures (boundary values land on the
// multi-byte varint64/zigzag64 paths). Hex bodies are the tails of
// WIDEAGG_BOUNDARY_RESPONSE / TAGSET_RESPONSE from wire_fixtures.rs.
const WIDEAGG_SAMPLE = {
  samples: [1n, 127n, 128n, 9007199254740993n, 18446744073709551615n],
  offset: -9223372036854775808n,
};
const WIDEAGG_RESPONSE = framed(hexToBytes('ffffffffffffffffff01f5ffffffffffffffff01'));
const TAGSET_SAMPLE = { ids: new Set([-7n, 1000n, 15n]) };
const TAGSET_RESPONSE = framed(hexToBytes('0303742d3705743130303003743135'));

export function runTrackBBench(options = {}) {
  const iterations = numericOption(options.iterations, ITER);
  const warmup = numericOption(options.warmup, WARMUP);
  return {
    date: new Date().toISOString().slice(0, 10),
    command: 'bun scripts/track-b-bench.mjs',
    route: 'complex-binary-js',
    results: [
      benchEncode('wideAgg Vec<u64>+Option<i64>', wideAggCodec, WIDEAGG_SAMPLE, iterations, warmup),
      benchDecode('wideAgg Vec<u64>+Option<i64>', wideAggCodec, WIDEAGG_RESPONSE, iterations, warmup),
      benchEncode('tagSet Set<i64>', tagSetCodec, TAGSET_SAMPLE, iterations, warmup),
      benchDecode('tagSet Set<i64>', tagSetCodec, TAGSET_RESPONSE, iterations, warmup),
    ],
    allocationMode: 'per-call-writer-and-response',
    verified: true,
    limitations: [
      'does not measure Rust handler or C++ JSI marshalling (device smoke required)',
      'single-process wall-clock sample',
      'measures the JS codec path only — the C++ direct path is native and not measurable from this script',
    ],
  };
}

if (import.meta.main) {
  console.log(JSON.stringify(runTrackBBench(), null, 2));
}
