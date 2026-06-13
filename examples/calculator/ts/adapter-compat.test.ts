import assert from 'node:assert/strict';
import test from 'node:test';
import { configure } from '@rustra/types';
import { createBunEngine } from '../../../packages/bun/src/index.js';
import { createNodeEngine } from '../../../packages/node/src/index.js';
import { createReactNativeEngine } from '../../../packages/react-native/src/index.js';
import { createTauriEngine } from '../../../packages/tauri/src/index.js';
import { addNumbers } from '../generated/commands.js';
import type { EngineClient } from '../generated/types.js';

type Invocation = {
  command: string;
  args: unknown;
};

function createRecordingTransport() {
  const calls: Invocation[] = [];
  return {
    calls,
    async invoke(command: string, args?: unknown) {
      calls.push({ command, args });
      return { value: 42 };
    },
  };
}

async function assertGeneratedCommandWorks(
  name: string,
  engine: EngineClient,
  calls: Invocation[],
) {
  configure(engine);
  const result = await addNumbers({ a: 20, b: 22 });

  assert.deepEqual(result, { value: 42 }, `${name} should return transport result`);
  assert.deepEqual(
    calls,
    [{ command: 'addNumbers', args: { a: 20, b: 22 } }],
    `${name} should forward generated command through EngineClient.invoke`,
  );
}

test('node adapter forwards generated commands to injected Node transport', async () => {
  const transport = createRecordingTransport();
  await assertGeneratedCommandWorks('node', createNodeEngine(transport), transport.calls);
});

test('bun adapter forwards generated commands to injected Bun transport', async () => {
  const transport = createRecordingTransport();
  await assertGeneratedCommandWorks('bun', createBunEngine(transport), transport.calls);
});

test('tauri adapter routes generated commands through rustra_dispatch', async () => {
  const transport = createRecordingTransport();
  const engine = createTauriEngine({ invoke: transport.invoke });
  configure(engine);

  const result = await addNumbers({ a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });

  assert.deepEqual(transport.calls, [
    {
      command: 'rustra_dispatch',
      args: { command: 'addNumbers', args: { a: 20, b: 22 } },
    },
  ]);
});

test('react native adapter forwards generated commands through JSI native module', async () => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const nativeModule = {
    invoke(payload: ArrayBuffer): ArrayBuffer {
      const { command, args } = JSON.parse(decoder.decode(payload));
      return encoder.encode(JSON.stringify({ ok: true, result: { value: 42 } }))
        .buffer as ArrayBuffer;
    },
  };
  const engine = createReactNativeEngine(nativeModule);
  configure(engine);
  const result = await addNumbers({ a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });
});

test('adapter packages keep host-specific imports out of the shared contract path', async () => {
  const adapterSources = await Promise.all([
    import('node:fs/promises').then((fs) => fs.readFile('packages/node/src/index.ts', 'utf8')),
    import('node:fs/promises').then((fs) => fs.readFile('packages/bun/src/index.ts', 'utf8')),
    import('node:fs/promises').then((fs) => fs.readFile('packages/tauri/src/index.ts', 'utf8')),
    import('node:fs/promises').then((fs) =>
      fs.readFile('packages/react-native/src/index.ts', 'utf8'),
    ),
  ]);

  const source = adapterSources.join('\n');
  for (const banned of ['@tauri-apps', '@expo/', 'expo-modules']) {
    assert.equal(source.includes(banned), false, `adapter source leaked ${banned}`);
  }
  // `react-native` substring check: only flag if it appears in an import statement
  const importLines = source.split('\n').filter((l) => l.trimStart().startsWith('import '));
  for (const line of importLines) {
    assert.equal(
      line.includes('react-native'),
      false,
      `adapter source leaked react-native in import: ${line.trim()}`,
    );
  }
});
