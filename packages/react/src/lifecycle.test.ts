import type { EngineClient } from '@rustra/types';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement as h, Suspense, act } from 'react';
import { create } from 'react-test-renderer';
import {
  RustraProvider,
  useCommand,
  useSuspenseCommand,
  invalidateCommands,
  useMutation,
  useEvent,
} from './index.js';
import { inputKey } from './input-key.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const deferred = <T = unknown>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const command = Object.assign(
  async function command(_input?: unknown): Promise<unknown> {
    return undefined;
  },
  { commandId: 'audit.command' },
);
// Each fixture deliberately implements only its tested command, while the
// production engine interface is generic over all command results.
const wrap = (engine: unknown, child: React.ReactNode) =>
  h(RustraProvider, { engine: engine as EngineClient }, child);

test('mutation invoked from a layout effect uses that render callbacks', async () => {
  const calls: string[] = [];
  function View() {
    const mutation = useMutation(command, {
      onSuccess: () => calls.push('success'),
      onSettled: () => calls.push('settled'),
    });
    React.useLayoutEffect(() => {
      void mutation.mutateAsync(undefined);
    }, []);
    return null;
  }
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(wrap({ invoke: async () => 42 }, h(View)));
  });
  assert.deepEqual(calls, ['success', 'settled']);
  await act(async () => tree!.unmount());
});

test('child layout mutation snapshots updated parent callbacks', async () => {
  const calls: string[] = [];
  const engine = { invoke: async () => 42 };
  function Child({
    label,
    mutate,
  }: {
    label: string;
    mutate: (input: undefined) => Promise<unknown>;
  }) {
    React.useLayoutEffect(() => {
      void mutate(undefined);
    }, [label, mutate]);
    return null;
  }
  function Parent({ label }: { label: string }) {
    const mutation = useMutation(command, { onSuccess: () => calls.push(label) });
    return h(Child, { label, mutate: mutation.mutateAsync });
  }
  let tree: ReturnType<typeof create>;
  await act(async () => {
    tree = create(wrap(engine, h(Parent, { label: 'A' })));
  });
  await act(async () => {
    tree!.update(wrap(engine, h(Parent, { label: 'B' })));
  });
  await act(async () => tree!.unmount());
  assert.deepEqual(calls, ['A', 'B']);
});

test('input key distinguishes supported Set and ArrayBuffer values', () => {
  assert.notEqual(inputKey(new Set(['first'])), inputKey(new Set(['second'])));
});

test('useCommand rerenders with a changed Set and invokes using the new value', async () => {
  const calls: string[][] = [];
  let current!: ReturnType<typeof useCommand<unknown, unknown>>;
  const engine = {
    invoke: async (_name: string, input: Set<string>) => {
      calls.push([...input]);
      return [...input].join(',');
    },
  };
  function View({ value }: { value: Set<string> }) {
    current = useCommand(command, value);
    return h('span', null, String(current.data ?? ''));
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(wrap(engine, h(View, { value: new Set(['first']) })));
  });
  await act(async () => {
    root.update(wrap(engine, h(View, { value: new Set(['second']) })));
  });
  await act(async () => {
    await current.refetch();
  });
  const result = { calls, data: current.data };
  await act(async () => {
    root.unmount();
  });
  assert.equal(result.data, 'second');
});

test('Suspense cache is isolated for distinct provider engines', async () => {
  invalidateCommands();
  const calls: string[] = [];
  const engine = (owner: string) => ({
    invoke: async () => {
      calls.push(owner);
      return owner;
    },
  });
  function View() {
    return h('span', null, String(useSuspenseCommand(command, { id: 'same-id' })));
  }
  const render = async (e: unknown) => {
    let root!: ReturnType<typeof create>;
    await act(async () => {
      root = create(wrap(e, h(Suspense, { fallback: 'loading' }, h(View))));
    });
    return root;
  };
  const a = await render(engine('account-A'));
  const b = await render(engine('account-B'));
  const result = { first: a.toJSON(), second: b.toJSON(), calls };
  await act(async () => {
    a.unmount();
    b.unmount();
  });
  invalidateCommands();
  assert.deepEqual(result.second, { type: 'span', props: {}, children: ['account-B'] });
});

test('old mutation completing after engine replacement does not update new scope', async () => {
  const a = deferred();
  let current!: ReturnType<typeof useMutation<unknown, unknown>>;
  const callbacks: unknown[] = [];
  const engineA = { invoke: () => a.promise };
  const engineB = { invoke: async () => 'account-B' };
  function View({ owner }: { owner: string }) {
    current = useMutation(command, { onSuccess: (data) => callbacks.push({ owner, data }) });
    return h('span', null, String(current.data));
  }
  let root!: ReturnType<typeof create>, pending: Promise<unknown>;
  await act(async () => {
    root = create(wrap(engineA, h(View, { owner: 'A' })));
  });
  await act(async () => {
    pending = current.mutateAsync({ id: 'first' });
  });
  await act(async () => {
    root.update(wrap(engineB, h(View, { owner: 'B' })));
  });
  await act(async () => {
    a.resolve('account-A-result');
    await pending;
  });
  const result = { data: current.data, callbacks };
  await act(async () => {
    root.unmount();
  });
  assert.equal(result.data, undefined);
  assert.deepEqual(callbacks, [{ owner: 'A', data: 'account-A-result' }]);
});

test('async useEvent subscription does not deliver events after unmount', async () => {
  const registered = deferred<() => void>();
  let handler!: (value: string) => void;
  let unsubscriptions = 0;
  const events: string[] = [];
  const subscribe = (_name: string, cb: (value: string) => void) => {
    handler = cb;
    return registered.promise;
  };
  function View() {
    useEvent('tick', (value: string) => events.push(value), subscribe);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(h(View));
  });
  await act(async () => {
    root.unmount();
  });
  handler('after-unmount-before-registration-resolves');
  await act(async () => {
    registered.resolve(() => {
      unsubscriptions += 1;
    });
  });
  assert.deepEqual(events, []);
  assert.equal(unsubscriptions, 1);
});

test('old async subscription does not deliver events into replacement event callback', async () => {
  const oldSubscription = deferred<() => void>();
  const handlers = new Map<string, (value: string) => void>();
  const events: unknown[] = [];
  const subscribe = (name: string, cb: (value: string) => void) => {
    handlers.set(name, cb);
    return name === 'old' ? oldSubscription.promise : () => {};
  };
  function View({ event }: { event: string }) {
    useEvent(event, (value: string) => events.push({ event, value }), subscribe);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(h(View, { event: 'old' }));
  });
  await act(async () => {
    root.update(h(View, { event: 'new' }));
  });
  handlers.get('old')!('stale-payload');
  await act(async () => {
    oldSubscription.resolve(() => {});
    root.unmount();
  });
  assert.deepEqual(events, []);
});

test('useCommand uses changed ArrayBuffer contents after update and refetch', async () => {
  const calls: number[][] = [];
  let current!: ReturnType<typeof useCommand<unknown, unknown>>;
  const engine = {
    invoke: async (_name: string, input: ArrayBuffer) => {
      const bytes = [...new Uint8Array(input)];
      calls.push(bytes);
      return bytes.join(',');
    },
  };
  function View({ value }: { value: ArrayBuffer }) {
    current = useCommand(command, value);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(wrap(engine, h(View, { value: new Uint8Array([1]).buffer })));
  });
  await act(async () => {
    root.update(wrap(engine, h(View, { value: new Uint8Array([2]).buffer })));
  });
  await act(async () => {
    await current.refetch();
  });
  const result = { calls, data: current.data };
  await act(async () => {
    root.unmount();
  });
  assert.equal(result.data, '2');
});

test('mutation command replacement invalidates old pending result', async () => {
  const pendingA = deferred();
  const commandA = Object.assign(async function commandA() {}, { commandId: 'command-A' });
  const commandB = Object.assign(async function commandB() {}, { commandId: 'command-B' });
  const engine = {
    invoke: (name: string) =>
      name === 'command-A' ? pendingA.promise : Promise.resolve({ b: 'new-command-result' }),
  };
  let current!: ReturnType<typeof useMutation<unknown, unknown>>;
  function View({ commandFn }: { commandFn: typeof command }) {
    current = useMutation(commandFn);
    return null;
  }
  let root!: ReturnType<typeof create>, pending: Promise<unknown>;
  await act(async () => {
    root = create(wrap(engine, h(View, { commandFn: commandA })));
  });
  await act(async () => {
    pending = current.mutateAsync(undefined);
  });
  await act(async () => {
    root.update(wrap(engine, h(View, { commandFn: commandB })));
  });
  await act(async () => {
    pendingA.resolve({ a: 'old-command-result' });
    await pending;
  });
  const data = current.data;
  await act(async () => {
    root.unmount();
  });
  assert.equal(data, undefined);
});

test('value-equal inline records do not restart a mounted command', async () => {
  let calls = 0;
  const engine = {
    invoke: async () => {
      calls += 1;
      return 'value';
    },
  };
  function View() {
    const result = useCommand(command, { nested: { id: 1 }, value: 42n });
    return h('span', null, result.data as string);
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(wrap(engine, h(View)));
  });
  await act(async () => {
    root.update(wrap(engine, h(View)));
  });
  assert.deepEqual(root.toJSON(), { type: 'span', props: {}, children: ['value'] });
  assert.equal(calls, 1);
  await act(async () => {
    root.unmount();
  });
});

test('tagged identities distinguish records, undefined, special numbers, binary views, and Map contents', () => {
  const pairs: [unknown, unknown][] = [
    [42n, { $rustraBigInt: '42' }],
    [{ optional: undefined }, {}],
    [NaN, null],
    [Infinity, -Infinity],
    [-0, 0],
    [new Set(['one']), new Set(['two'])],
    [new Uint8Array([1]).buffer, new Uint8Array([2]).buffer],
    [new Uint8Array([1]), new Int8Array([1])],
    [new Map([['id', 1]]), new Map([['id', 2]])],
    [new Date(0), new Date(1)],
    [new Array(1), [undefined]],
  ];
  for (const [first, second] of pairs) assert.notEqual(inputKey(first), inputKey(second));
  assert.equal(inputKey({ b: 2, a: 1 }), inputKey({ a: 1, b: 2 }));
  const bytes = new Uint8Array([9, 1, 2, 9]);
  assert.equal(inputKey(bytes.subarray(1, 3)), inputKey(new Uint8Array([1, 2])));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  assert.throws(() => inputKey(cycle), /cycles/);
  assert.throws(() => inputKey({ callback: () => {} }), /functions/);
});

test('mutation error keeps invocation callbacks and cannot overwrite replacement state', async () => {
  let reject!: (error: Error) => void;
  const pending = new Promise((_, r) => {
    reject = r;
  });
  const callbacks: string[] = [];
  let current!: ReturnType<typeof useMutation<unknown, unknown>>;
  const engineA = { invoke: () => pending };
  const engineB = { invoke: async () => 'new' };
  function View({ owner }: { owner: string }) {
    current = useMutation(command, {
      onError: () => callbacks.push(`${owner}:error`),
      onSettled: () => callbacks.push(`${owner}:settled`),
    });
    return null;
  }
  let root!: ReturnType<typeof create>, old: Promise<unknown>;
  await act(async () => {
    root = create(wrap(engineA, h(View, { owner: 'A' })));
  });
  await act(async () => {
    old = current.mutateAsync(undefined);
    old.catch(() => {});
  });
  await act(async () => {
    root.update(wrap(engineB, h(View, { owner: 'B' })));
  });
  await act(async () => {
    await current.mutateAsync(undefined);
  });
  await act(async () => {
    reject(new Error('old failure'));
    await assert.rejects(old!);
  });
  assert.equal(current.data, 'new');
  assert.equal(current.error, null);
  assert.equal(current.loading, false);
  assert.deepEqual(callbacks, ['B:settled', 'A:error', 'A:settled']);
  await act(async () => {
    root.unmount();
  });
});

test('mutation reset excludes pending results while preserving invocation callbacks', async () => {
  const pending = deferred();
  const callbacks: string[] = [];
  let current!: ReturnType<typeof useMutation<unknown, unknown>>;
  function View() {
    current = useMutation(command, {
      onSuccess: (value) => callbacks.push(value as unknown as string),
    });
    return null;
  }
  let root!: ReturnType<typeof create>, result: Promise<unknown>;
  await act(async () => {
    root = create(wrap({ invoke: () => pending.promise }, h(View)));
  });
  await act(async () => {
    result = current.mutateAsync(undefined);
  });
  await act(async () => {
    current.reset();
  });
  await act(async () => {
    pending.resolve('old');
    await result;
  });
  assert.equal(current.data, undefined);
  assert.equal(current.loading, false);
  assert.deepEqual(callbacks, ['old']);
  await act(async () => {
    root.unmount();
  });
});

test('event callback updates without resubscribing and synchronous cleanup runs once', async () => {
  let handler!: (payload: string) => void;
  let subscriptions = 0,
    cleanups = 0;
  const events: string[] = [];
  const subscribe = (_event: string, callback: (payload: string) => void) => {
    subscriptions += 1;
    handler = callback;
    return () => {
      cleanups += 1;
    };
  };
  function View({ label }: { label: string }) {
    useEvent('tick', (payload: string) => events.push(`${label}:${payload}`), subscribe);
    return null;
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(h(View, { label: 'old' }));
  });
  await act(async () => {
    root.update(h(View, { label: 'new' }));
  });
  handler('current');
  await act(async () => {
    root.unmount();
  });
  handler('stale');
  assert.deepEqual(events, ['new:current']);
  assert.equal(subscriptions, 1);
  assert.equal(cleanups, 1);
});

test('mounted Suspense shows fallback then renders the command result', async () => {
  const pending = deferred();
  const calls: unknown[] = [];
  const engine = {
    invoke: (name: string, input: unknown, options: unknown) => {
      calls.push([name, input, options]);
      return pending.promise;
    },
  };
  const options = { timeoutMs: 1234 };
  const renamed = Object.assign(
    async function mangled(): Promise<string> {
      return '';
    },
    { commandId: 'real-command-id' },
  );
  function View() {
    return h('span', null, useSuspenseCommand(renamed, undefined, options));
  }
  let root!: ReturnType<typeof create>;
  await act(async () => {
    root = create(wrap(engine, h(Suspense, { fallback: 'waiting' }, h(View))));
  });
  assert.equal(root.toJSON(), 'waiting');
  await act(async () => {
    pending.resolve('ready');
  });
  assert.deepEqual(calls, [['real-command-id', undefined, options]]);
  assert.deepEqual(root.toJSON(), { type: 'span', props: {}, children: ['ready'] });
  await act(async () => {
    root.unmount();
  });
  invalidateCommands(undefined, engine as EngineClient);
});

test('overlapping mutations retain loading until all finish and keep invocation-time callbacks', async () => {
  const older = deferred(),
    newer = deferred();
  const callbacks: string[] = [];
  let current!: ReturnType<typeof useMutation<unknown, unknown>>;
  const engine = {
    invoke: (_command: string, input: string) =>
      input === 'older' ? older.promise : newer.promise,
  };
  function View({ label }: { label: string }) {
    current = useMutation(command, { onSuccess: (value) => callbacks.push(`${label}:${value}`) });
    return null;
  }
  let root!: ReturnType<typeof create>, first: Promise<unknown>, second: Promise<unknown>;
  await act(async () => {
    root = create(wrap(engine, h(View, { label: 'A' })));
  });
  await act(async () => {
    first = current.mutateAsync('older');
  });
  await act(async () => {
    root.update(wrap(engine, h(View, { label: 'B' })));
  });
  await act(async () => {
    second = current.mutateAsync('newer');
  });
  await act(async () => {
    newer.resolve('new');
    await second;
  });
  assert.equal(current.data, 'new');
  assert.equal(current.loading, true);
  await act(async () => {
    older.resolve('old');
    await first;
  });
  assert.equal(current.data, 'new');
  assert.equal(current.loading, false);
  assert.deepEqual(callbacks, ['B:new', 'A:old']);
  await act(async () => {
    root.unmount();
  });
});
