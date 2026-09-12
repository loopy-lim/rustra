import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, Suspense } from 'react';
import { renderToReadableStream } from 'react-dom/server';
import { configure } from '@rustra/types';
import type { EngineClient } from '@rustra/types';
import * as hooks from './index.js';
import { resolveSuspenseEntry } from './useSuspenseCommand.js';

const command = Object.assign(
  async function profile(): Promise<string> {
    return '';
  },
  { commandId: 'profile' },
);
const engine = (value: string): EngineClient => ({ invoke: async <T>() => value as T });
async function render(owner?: EngineClient): Promise<string> {
  function View() {
    return h('span', null, hooks.useSuspenseCommand(command));
  }
  const child = h(Suspense, { fallback: 'loading' }, h(View));
  const stream = await renderToReadableStream(
    owner ? h(hooks.RustraProvider, { engine: owner }, child) : child,
  );
  await stream.allReady;
  return new Response(stream).text();
}

test('streaming SSR isolates account data by request engine', async () => {
  hooks.invalidateCommands();
  assert.match(await render(engine('account-A')), /account-A/);
  assert.match(await render(engine('account-B')), /account-B/);
  hooks.invalidateCommands();
});

test('replacing the global registration creates a fresh default cache scope', async () => {
  hooks.invalidateCommands();
  configure(engine('private-A'));
  assert.match(await render(), /private-A/);
  configure(engine('private-B'));
  const html = await render();
  assert.match(html, /private-B/);
  assert.doesNotMatch(html, /private-A/);
  hooks.invalidateCommands();
});

test('default engine cache survives Suspense retries and is shared across component instances', async () => {
  hooks.invalidateCommands();
  let calls = 0;
  configure({
    invoke: async <T>() => {
      calls += 1;
      return 'default-result' as T;
    },
  });
  assert.match(await render(), /default-result/);
  assert.match(await render(), /default-result/);
  assert.equal(calls, 1);
  hooks.invalidateCommands();
});

test('scoped invalidation refreshes only the requested engine and exact command', async () => {
  hooks.invalidateCommands();
  let callsA = 0,
    callsB = 0;
  const a: EngineClient = { invoke: async <T>() => `A-${++callsA}` as T };
  const b: EngineClient = { invoke: async <T>() => `B-${++callsB}` as T };
  await render(a);
  await render(b);
  hooks.invalidateCommands('profile', a);
  assert.match(await render(a), /A-2/);
  assert.match(await render(b), /B-1/);
  hooks.invalidateCommands('profile');
  assert.match(await render(b), /B-2/);
  hooks.invalidateCommands(undefined, a);
  assert.match(await render(a), /A-3/);
  hooks.invalidateCommands();
});

test('cache capacity evicts settled least recently used values, preserving active requests', async () => {
  const owner = engine('unused');
  hooks.configureSuspenseCache({ maxEntries: 2 }, owner);
  const entry = (key: string) =>
    resolveSuspenseEntry(key, 'profile', () => Promise.resolve(key), owner);
  const first = entry('first');
  await first.promise;
  const second = entry('second');
  await second.promise;
  assert.equal(entry('first'), first);
  await entry('third').promise;
  assert.notEqual(entry('second'), second);
  hooks.invalidateCommands(undefined, owner);
});

test('cache expires settled values and times out requests that never settle', async () => {
  const owner = engine('unused');
  hooks.configureSuspenseCache({ ttlMs: 15, pendingTimeoutMs: 15 }, owner);
  const first = resolveSuspenseEntry('ready', 'profile', () => Promise.resolve('first'), owner);
  await first.promise;
  const stuck = resolveSuspenseEntry(
    'stuck',
    'profile',
    () => new Promise<string>(() => {}),
    owner,
  );
  await assert.rejects(stuck.promise, /timed out/i);
  assert.equal(stuck.status, 'rejected');
  const next = resolveSuspenseEntry('ready', 'profile', () => Promise.resolve('next'), owner);
  assert.notEqual(next, first);
  await next.promise;
  hooks.invalidateCommands(undefined, owner);
});

test('cache refuses excess pending requests without evicting their promises', async () => {
  const owner = engine('unused');
  hooks.configureSuspenseCache({ maxEntries: 1 }, owner);
  let finish!: (value: string) => void;
  const first = resolveSuspenseEntry(
    'first',
    'profile',
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
    owner,
  );
  assert.throws(
    () => resolveSuspenseEntry('second', 'profile', () => Promise.resolve('second'), owner),
    /capacity/i,
  );
  assert.equal(
    resolveSuspenseEntry('first', 'profile', () => Promise.resolve('wrong'), owner),
    first,
  );
  finish('complete');
  await first.promise;
  hooks.invalidateCommands(undefined, owner);
});

test('invalidating an active entry never lets late completion repopulate the cache', async () => {
  const owner = engine('unused');
  let finish!: (value: string) => void;
  const old = resolveSuspenseEntry(
    'key',
    'profile',
    () =>
      new Promise<string>((r) => {
        finish = r;
      }),
    owner,
  );
  hooks.invalidateCommands(undefined, owner);
  const fresh = resolveSuspenseEntry('key', 'profile', () => Promise.resolve('fresh'), owner);
  await fresh.promise;
  finish('old');
  await old.promise;
  assert.equal(
    resolveSuspenseEntry('key', 'profile', () => Promise.resolve('wrong'), owner).value,
    'fresh',
  );
  hooks.invalidateCommands(undefined, owner);
});
