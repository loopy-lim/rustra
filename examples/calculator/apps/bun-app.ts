import { spawnSync } from 'node:child_process';
import { addNumbers } from '../generated/commands.js';
import { configure, createBunEngine } from '../../../packages/bun/src/index.js';

const engine = createBunEngine({
  invoke(command: string, args?: unknown) {
    return invokeCalculatorRuntime(command, args);
  },
});
configure(engine);

const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`bun runtime result: ${result.value}`);

function invokeCalculatorRuntime(command: string, args: unknown): unknown {
  const output = spawnSync('target/debug/rustra-calculator-example', ['invoke'], {
    input: JSON.stringify({ command, args }),
    encoding: 'utf8',
  });

  if (output.status !== 0) {
    throw new Error(output.stderr || `runtime exited ${output.status}`);
  }

  const response = JSON.parse(output.stdout) as { ok: true; result: unknown };
  return response.result;
}
