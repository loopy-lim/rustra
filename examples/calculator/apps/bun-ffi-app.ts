import { addNumbers, rustra } from '../generated/bun.js';

const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`bun FFI zero-config result: ${result.value}`);
rustra.dispose();
