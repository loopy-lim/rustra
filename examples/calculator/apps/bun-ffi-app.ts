import { dlopen, FFIType, suffix, CString } from 'bun:ffi';
import { configure, createBunEngine } from '../../../packages/bun/src/index.js';
import { addNumbers } from '../generated/commands.js';

const lib = dlopen(`target/debug/librustra_calculator_example.${suffix}`, {
  rustra_calculator_invoke: {
    args: [FFIType.cstring],
    returns: FFIType.ptr,
  },
  rustra_calculator_free_string: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
});

const engine = createBunEngine({
  invoke(command: string, args?: unknown): unknown {
    const payload = Buffer.from(JSON.stringify({ command, args }) + '\0');
    const rawPtr = lib.symbols.rustra_calculator_invoke(payload);
    const rawResponse = new CString(rawPtr);
    lib.symbols.rustra_calculator_free_string(rawPtr);

    const response = JSON.parse(rawResponse) as {
      ok: boolean;
      result?: unknown;
      error?: string;
    };

    if (!response.ok) {
      throw new Error(response.error ?? 'invoke failed');
    }

    return response.result;
  },
});
configure(engine);

const result = await addNumbers({ a: 20, b: 22 });

if (result !== 42) {
  throw new Error(`expected 42, got ${result}`);
}

console.log(`bun FFI result: ${result}`);
