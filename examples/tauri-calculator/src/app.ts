import { configure } from '@rustra/types';
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
configure(engine);

const result = await addNumbers({ a: 20, b: 22 });
const output = document.querySelector('output');

if (output) {
  output.value = String(result);
}

document.body.dataset.result = String(result);
console.log(`tauri runtime result: ${result}`);
