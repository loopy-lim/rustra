import assert from 'node:assert/strict';
import test from 'node:test';
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

async function assertGeneratedCommandWorks(name: string, engine: EngineClient, calls: Invocation[]) {
  const result = await addNumbers(engine, { a: 20, b: 22 });

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

  const result = await addNumbers(engine, { a: 20, b: 22 });
  assert.deepEqual(result, { value: 42 });

  assert.deepEqual(transport.calls, [
    {
      command: 'rustra_dispatch',
      args: { command: 'addNumbers', args: { a: 20, b: 22 } },
    },
  ]);
});

test('react native adapter forwards generated commands to injected native module', async () => {
  const transport = createRecordingTransport();
  await assertGeneratedCommandWorks(
    'react-native',
    createReactNativeEngine({ invoke: transport.invoke }),
    transport.calls,
  );
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
  for (const banned of ['@tauri-apps', 'react-native', '@expo/', 'expo-modules']) {
    assert.equal(source.includes(banned), false, `adapter source leaked ${banned}`);
  }
});
