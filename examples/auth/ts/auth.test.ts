import assert from 'node:assert/strict';
import test from 'node:test';
import { configure, RustraCommandError } from '@rustra/types';
import { signIn, signOut, grant, adminStats } from '../generated/commands.js';
import type { EngineClient } from '../generated/types.js';

type Handler = (command: string, args?: unknown) => unknown;

function mockEngine(handler: Handler): EngineClient {
  return {
    async invoke<T>(command: string, args?: unknown): Promise<T> {
      return handler(command, args) as T;
    },
  };
}

test('signIn returns token and role', async () => {
  configure(
    mockEngine((cmd) => {
      assert.equal(cmd, 'signIn');
      return { token: 'tok-1', role: 'admin' };
    }),
  );
  const result = await signIn({ username: 'root', password: 'hunter2' });
  assert.equal(result.token, 'tok-1');
  assert.equal(result.role, 'admin');
});

test('grant carries capability name on wire', async () => {
  let seen: unknown;
  configure(
    mockEngine((cmd, args) => {
      assert.equal(cmd, 'grant');
      seen = args;
      return { granted: true };
    }),
  );
  const result = await grant({ token: 'tok-1', capability: 'admin.stats' });
  assert.equal(result.granted, true);
  assert.deepEqual(seen, { token: 'tok-1', capability: 'admin.stats' });
});

test('capability.denied error code is preserved through RustraCommandError', async () => {
  configure(
    mockEngine(() => {
      // JSON fallback 경로 에러 — Rust Display 포맷 "code: message"
      const err = new Error('capability.denied: admin.stats required');
      throw Object.assign(err, { rustraFlattened: true });
    }),
  );
  try {
    await adminStats({ token: 'none' });
    assert.fail('should have thrown');
  } catch (e) {
    const msg = (e as Error).message;
    assert.ok(msg.includes('capability.denied'), `code preserved: ${msg}`);
  }
});

test('signOut reports session removal', async () => {
  configure(mockEngine(() => ({ signedOut: true })));
  const result = await signOut({ token: 'tok-1' });
  assert.equal(result.signedOut, true);
});

test('generated types include auth command surface', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  // 컴파일 위치(dist-ts/...)에서 소스 트리의 generated/*.ts 로 —
  // dist-ts 루트에서 2단계 상위가 repo 루트다.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const srcDir = `${here.split('/dist-ts/')[0]}/examples/auth/generated/`;
  const types = await readFile(`${srcDir}/types.ts`, 'utf8');
  assert.ok(types.includes('export type SignInInput = {'));
  assert.ok(types.includes('export type AdminStatsOutput = {'));
  const commands = await readFile(`${srcDir}/commands.ts`, 'utf8');
  assert.ok(commands.includes('export function signIn'));
  assert.ok(commands.includes('export function adminStats'));
});
