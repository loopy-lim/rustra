import { spawnSync } from 'node:child_process';
import { addNumbers } from '../generated/commands.js';
import { createNodeEngine } from '../../../packages/node/src/index.js';

const engine = createNodeEngine({
  invoke(command, args) {
    return invokeCalculatorRuntime(command, args);
  },
});

const result = await addNumbers(engine, { a: 20, b: 22 });

if (result !== 42) {
  throw new Error(`expected 42, got ${result}`);
}

console.log(`node runtime result: ${result}`);

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
