import { addNumbers } from '../generated/commands.js';
import { createReactNativeEngine } from '../../../packages/react-native/src/index.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const NativeRustraModule = {
  invoke(payload: ArrayBuffer): ArrayBuffer {
    const { command, args } = JSON.parse(decoder.decode(payload));
    return encoder.encode(JSON.stringify({ ok: true, result: 42 })).buffer as ArrayBuffer;
  },
};

const engine = createReactNativeEngine(NativeRustraModule);
const result = await addNumbers(engine, { a: 20, b: 22 });

if (result !== 42) {
  throw new Error(`expected 42, got ${result}`);
}

console.log(`react native injected module result: ${result}`);
