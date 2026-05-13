import { addNumbers } from '../generated/commands.js';
import { createTauriEngine } from '../../../packages/tauri/src/index.js';

const calls: Array<{ command: string; args: unknown }> = [];

const engine = createTauriEngine({
  async invoke(command: string, args?: unknown) {
    calls.push({ command, args });
    return { value: 42 };
  },
});

const result = await addNumbers(engine, { a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

if (JSON.stringify(calls) !== JSON.stringify([{ command: 'addNumbers', args: { a: 20, b: 22 } }])) {
  throw new Error(`unexpected Tauri invoke calls: ${JSON.stringify(calls)}`);
}

console.log(`tauri injected invoke result: ${result.value}`);
