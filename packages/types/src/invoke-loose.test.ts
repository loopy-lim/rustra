// invokeLoose 단위 테스트 — 동적 티어의 명명된 저작 표면(Dev Tier A절).
// 저장소 표준(node:test + node:assert/strict, ESM) 사용 — 새 의존성 없음.
import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeLoose } from './invoke-loose.js';
import type { EngineClient } from './public.js';

test('invokeLoose delegates to the engine by command name', async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  const client: EngineClient = {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      calls.push({ command, args });
      return { os: 'darwin' } as T;
    },
  };
  const out = await invokeLoose<{ os: string }>(client, 'platformNativeInfo');
  assert.equal(out.os, 'darwin');
  assert.deepEqual(calls, [{ command: 'platformNativeInfo', args: undefined }]);
});

test('invokeLoose forwards args and options untouched', async () => {
  const controller = new AbortController();
  const seen: { args?: unknown; signal?: AbortSignal }[] = [];
  const client: EngineClient = {
    async invoke<T>(
      command: string,
      args?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<T> {
      seen.push({ args, signal: options?.signal });
      return 42 as T;
    },
  };
  const value = await invokeLoose<number>(
    client,
    'clamp',
    { value: 1 },
    {
      signal: controller.signal,
    },
  );
  assert.equal(value, 42);
  assert.deepEqual(seen[0]?.args, { value: 1 });
  assert.equal(seen[0]?.signal, controller.signal);
});

test('invokeLoose defaults the result type to unknown', async () => {
  const client: EngineClient = {
    async invoke<T>(_command: string): Promise<T> {
      return { anything: true } as T;
    },
  };
  const out: unknown = await invokeLoose(client, 'echoGroups');
  assert.deepEqual(out, { anything: true });
});
