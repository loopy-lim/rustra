import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { configure } from '@rustra/types';
import { addNumbers } from '../generated/commands.js';
import type { EngineClient } from '../generated/types.js';

test('generated command helper calls the host EngineClient invoke contract', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const engine: EngineClient = {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      calls.push({ command, args });
      return { value: 42 } as T;
    },
  };
  configure(engine);

  const result = await addNumbers({ a: 20, b: 22 });

  assert.deepEqual(result, { value: 42 });
  assert.deepEqual(calls, [
    {
      command: 'addNumbers',
      args: { a: 20, b: 22 },
    },
  ]);
});

test('generated client stays host neutral for Node, Bun, Tauri, and React Native', async () => {
  const commands = await readFile(
    join(process.cwd(), 'examples/calculator/generated/commands.ts'),
    'utf8',
  );
  const types = await readFile(
    join(process.cwd(), 'examples/calculator/generated/types.ts'),
    'utf8',
  );
  const generated = `${commands}\n${types}`;

  for (const banned of [
    'node:',
    'bun:',
    '@tauri-apps',
    'react-native',
    '@expo/',
    'expo-modules',
    'EngineRequest',
    'Attachment',
  ]) {
    assert.equal(generated.includes(banned), false, `generated client leaked ${banned}`);
  }
});
