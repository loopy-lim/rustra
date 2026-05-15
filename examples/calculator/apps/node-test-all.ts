/**
 * Node.js test app — exercises all calculator commands across Tier 1/2/3.
 *
 * Uses JSON transport via createNodeEngine + spawned Rust binary.
 * Tests the command logic and TypeScript types.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { configure } from '@rustra/types';

const BIN = resolve(import.meta.dirname, '../../../target/debug/rustra-calculator-example');

// ── JSON transport ──────────────────────────────────────────

function invokeCalculatorRuntime(command: string, args: unknown): unknown {
  const output = spawnSync(BIN, ['invoke'], {
    input: JSON.stringify({ command, args }),
    encoding: 'utf8',
  });
  if (output.error) throw output.error;
  if (output.status !== 0) {
    throw new Error(output.stderr?.trim() || `runtime exited ${output.status}`);
  }
  const response = JSON.parse(output.stdout) as { ok: boolean; result?: unknown; error?: string };
  if (!response.ok) throw new Error(response.error ?? 'unknown error');
  return response.result;
}

const engine = {
  async invoke<T>(command: string, args?: unknown): Promise<T> {
    return invokeCalculatorRuntime(command, args) as T;
  },
};
configure(engine);

// ── Test helpers ────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// ── Tier 1 tests ────────────────────────────────────────────

console.log('\n=== Tier 1: Fixed-width primitives ===\n');

{
  const result = await engine.invoke<{ value: number }>('addNumbers', { a: 42, b: 58 });
  assert(result.value === 100, `addNumbers(42, 58) = ${result.value}`);
}

{
  const result = await engine.invoke<{ value: number }>('multiply', { a: 3.14, b: 2.0 });
  assert(Math.abs(result.value - 6.28) < 0.001, `multiply(3.14, 2.0) = ${result.value}`);
}

{
  const result = await engine.invoke<{ result: boolean }>('isEven', { n: 42 });
  assert(result.result === true, `isEven(42) = ${result.result}`);

  const result2 = await engine.invoke<{ result: boolean }>('isEven', { n: 7 });
  assert(result2.result === false, `isEven(7) = ${result2.result}`);
}

{
  const result = await engine.invoke<{ value: number }>('clamp', { value: 15.0, min: 0.0, max: 10.0 });
  assert(result.value === 10.0, `clamp(15, 0, 10) = ${result.value}`);
}

// ── Tier 2 tests ────────────────────────────────────────────

console.log('\n=== Tier 2: String / Vec<primitive> ===\n');

{
  const result = await engine.invoke<{ message: string }>('greet', { name: 'Rustra' });
  assert(result.message === 'Hello, Rustra!', `greet("Rustra") = "${result.message}"`);
}

{
  const result = await engine.invoke<{ total: number; count: number }>('sumList', { numbers: [1, 2, 3, 4, 5] });
  assert(result.total === 15, `sumList([1..5]).total = ${result.total}`);
  assert(result.count === 5, `sumList([1..5]).count = ${result.count}`);
}

{
  const result = await engine.invoke<{ result: string }>('toUpper', { s: 'hello' });
  assert(result.result === 'HELLO', `toUpper("hello") = "${result.result}"`);
}

// ── Tier 3 tests ────────────────────────────────────────────

console.log('\n=== Tier 3: Nested structs ===\n');

{
  const result = await engine.invoke<{ item: { name: string; value: number; active: boolean } }>(
    'createItem', { name: 'Widget', value: 42 },
  );
  assert(result.item.name === 'Widget', `createItem: name = "${result.item.name}"`);
  assert(result.item.value === 42, `createItem: value = ${result.item.value}`);
  assert(result.item.active === true, `createItem: active = ${result.item.active}`);
}

{
  const result = await engine.invoke<{ item: { name: string; value: number; active: boolean }; doubled: boolean }>(
    'processItem', { item: { name: 'Gadget', value: 200, active: true } },
  );
  assert(result.item.name === 'processed_Gadget', `processItem: name = "${result.item.name}"`);
  assert(result.item.value === 400, `processItem: value = ${result.item.value}`);
  assert(result.doubled === true, `processItem: doubled = ${result.doubled}`);
}

// ── Summary ─────────────────────────────────────────────────

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
