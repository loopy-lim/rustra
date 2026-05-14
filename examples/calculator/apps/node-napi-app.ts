import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createNodeEngine } from '../../../packages/node/src/index.js';
import { addNumbers } from '../generated/commands.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const napiPath = resolve(__dirname, '..', '..', '..', '..', 'examples', 'calculator-napi', `calculator-napi.${process.platform}-${process.arch}.node`);
const native = createRequire(__dirname)(napiPath) as { rustraInvoke: (cmd: string, args: string | undefined) => string };

const engine = createNodeEngine({
  async invoke(command: string, args?: unknown): Promise<unknown> {
    const argsJson = args !== undefined ? JSON.stringify(args) : undefined;
    const rawResponse = native.rustraInvoke(command, argsJson);

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

const result = await addNumbers(engine, { a: 20, b: 22 });

if (result.value !== 42) {
  throw new Error(`expected 42, got ${result.value}`);
}

console.log(`node napi-rs result: ${result.value}`);
