import { addNumbers, rustra } from '../generated/bun.js';
import { benchmarkCommand } from './performance-stats.js';

const result = await benchmarkCommand({
  name: 'bun-generated-ffi-rkyv-v2',
  invoke: () => addNumbers({ a: 20, b: 22 }),
  validate: (output) => output.value === 42,
  warmup: 500,
  iterations: 10_000,
});
rustra.dispose();

console.log(
  `RUSTRA_HOST_BENCH_JSON=${JSON.stringify({ runtime: `Bun ${Bun.version}`, results: [result] })}`,
);
