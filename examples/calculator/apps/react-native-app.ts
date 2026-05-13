import { addNumbers } from '../generated/commands.js';
import { createReactNativeEngine } from '../../../packages/react-native/src/index.js';

const calls: Array<{ command: string; args: unknown }> = [];

const NativeRustraModule = {
  async invoke(command: string, args?: unknown) {
    calls.push({ command, args });
    return { value: 42 };
  },
};

const engine = createReactNativeEngine(NativeRustraModule);
const result = await addNumbers(engine, { a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

if (JSON.stringify(calls) !== JSON.stringify([{ command: 'addNumbers', args: { a: 20, b: 22 } }])) {
  throw new Error(`unexpected React Native module calls: ${JSON.stringify(calls)}`);
}

console.log(`react native injected module result: ${result.value}`);
