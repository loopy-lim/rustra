// invokeLoose e2e — 동적 티어 저작 표면을 클라이언트 회로로 검증(Dev Tier A절).
// 저장소 표준(node:test + node:assert/strict, ESM) 사용.
import assert from 'node:assert/strict';
import test from 'node:test';
import { invokeLoose } from '@rustra/types';

test('invokeLoose prototypes a command by name without a generated client', async () => {
  const calls: string[] = [];
  const client = {
    async invoke<T>(command: string): Promise<T> {
      calls.push(command);
      return { os: 'darwin' } as T;
    },
  };
  const out = await invokeLoose<{ os: string }>(client, 'platformNativeInfo');
  assert.equal(out.os, 'darwin');
  assert.deepEqual(calls, ['platformNativeInfo']);
});
