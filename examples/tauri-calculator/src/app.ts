import { addNumbers } from '../../calculator/generated/commands.js';
import { createTauriEngine } from '../../../packages/tauri/src/index.js';

declare global {
  interface Window {
    __TAURI__: {
      core: {
        invoke<T>(command: string, args?: unknown): Promise<T>;
      };
    };
  }
}

const engine = createTauriEngine({
  invoke: window.__TAURI__.core.invoke,
});

const result = await addNumbers(engine, { a: 20, b: 22 });
const output = document.querySelector('output');

if (output) {
  output.value = String(result.value);
}

document.body.dataset.result = String(result.value);
console.log(`tauri runtime result: ${result.value}`);
