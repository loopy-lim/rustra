import { addNumbers } from '../generated/commands.js';
// barrel(index) 대신 개별 모듈 import — react-doctor no-barrel-import.
import { configure } from '../../../packages/types/src/global-config.js';
import { createReactNativeEngine } from '../../../packages/react-native/src/react-native-core.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const NativeRustraModule = {
  invoke(payload: ArrayBuffer): ArrayBuffer {
    const decoded: unknown = JSON.parse(decoder.decode(payload));
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('command' in decoded) ||
      decoded.command !== 'addNumbers' ||
      !('args' in decoded) ||
      typeof decoded.args !== 'object' ||
      decoded.args === null ||
      !('a' in decoded.args) ||
      !('b' in decoded.args) ||
      typeof decoded.args.a !== 'number' ||
      typeof decoded.args.b !== 'number'
    ) {
      throw new TypeError('expected addNumbers with numeric a and b arguments');
    }
    const value = decoded.args.a + decoded.args.b;
    return encoder.encode(JSON.stringify({ ok: true, result: { value } })).buffer as ArrayBuffer;
  },
};

const engine = createReactNativeEngine(NativeRustraModule);
configure(engine);
const result = await addNumbers({ a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`react native injected module result: ${result.value}`);
