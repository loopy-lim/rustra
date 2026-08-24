import { addNumbers, rustra } from '../generated/node.js';

const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`node runtime result: ${result.value}`);
rustra.dispose();
