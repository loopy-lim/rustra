English | [한국어](./README.ko.md)

# @rustra/react

React hooks and context bindings for Rustra command clients.

```tsx
import { RustraProvider, useCommand } from '@rustra/react';
import { getItem } from './generated/commands.js';

function Item({ id }: { id: string }) {
  const { data, loading, error } = useCommand(getItem, { id });
  if (loading) return <span>Loading...</span>;
  if (error) return <span>{error.message}</span>;
  return <span>{data?.name}</span>;
}

<RustraProvider engine={engine}>
  <Item id="item-1" />
</RustraProvider>;
```

The package provides `RustraProvider`, `useRustraEngine`, `useCommand`,
`useMutation`, `useEvent`, `useSuspenseCommand`, `invalidateCommands`, and
`configureSuspenseCache`. React is a peer dependency;
configure the platform-specific Rustra engine before rendering the provider.

`useSuspenseCommand(commandFn, input?, options?)` is the Suspense-compatible read:
it suspends by throwing the in-flight promise until the command resolves, then
returns the value directly (a rejection is re-thrown to the nearest error
boundary). Results are keyed by the provider's `EngineClient` identity, command
name, and structural input. Use a separate provider engine for every SSR request
or account; sharing one engine intentionally shares its cache. Without a provider,
all components share the current global registration scope. Replacing or disposing
the registration creates a fresh scope on the next render; stale retained callbacks
cannot invoke the replacement engine. Use a request-specific Provider for concurrent SSR users.

Each engine keeps at most **256 entries**. Completed entries expire **5 minutes**
after settlement; insertion at capacity evicts the least recently accessed settled
entry. Pending promises are protected from eviction so Suspense retries reuse the
same work. If all slots are pending, a new key throws a capacity error to the error
boundary. A pending entry rejects after **30 seconds** and can then be evicted or
expire. The cache deadline stops waiting; it does not cancel the underlying engine
operation. Invocation options apply only when creating the entry.

`configureSuspenseCache({ maxEntries, ttlMs, pendingTimeoutMs }, engine?)` changes
one engine's policy and clears its existing entries; omit the engine to configure
the global default scope. Values must be positive safe integers (time values at
most 2,147,483,647 ms). Explicitly invalidating pending work leaves its promise
intact for current callers, but late completion never repopulates the cache.

- `invalidateCommands('getItem', engine)` clears that exact command in one engine.
- `invalidateCommands(undefined, engine)` clears one engine's entire cache.
- `invalidateCommands('getItem')` clears that exact command across live engines.
- `invalidateCommands()` clears every live cache.

Invalidation and expiry take effect on the next render; neither triggers a render
by itself. Engines are weakly held, and cached results also have finite retention.

```tsx
import { Suspense } from 'react';
import { invalidateCommands, useSuspenseCommand } from '@rustra/react';
import { getItem, saveItem } from './generated/commands.js';

function Item({ id }: { id: string }) {
  const item = useSuspenseCommand(getItem, { id }); // suspends until resolved
  return <span>{item.name}</span>;
}

async function rename(id: string, name: string) {
  await saveItem({ id, name });
  invalidateCommands('getItem'); // next render of <Item> re-fetches
}

<Suspense fallback={<span>Loading...</span>}>
  <Item id="item-1" />
</Suspense>;
```

`useCommand` and `useSuspenseCommand` accept structural inputs containing plain
records, arrays, bigint, Set, Map, Date, ArrayBuffer, and typed binary views. Keys
include value types and binary contents; plain-record field order is ignored,
while Set/Map iteration order and binary view types are preserved. Functions,
symbols, cyclic structures, and unsupported class instances are rejected with a
TypeError instead of silently colliding. The engine receives the original input.

`useMutation` resets visible state when its engine or resolved command changes.
An in-flight call can still settle and return to its caller, but it cannot update
a replacement scope or a reset/unmounted hook. Success/error/settled callbacks
are captured at invocation time and still belong to that invocation, including
when it settles after a reset or scope change. Overlapping calls keep `loading`
true until all current-scope calls settle; only the latest call updates data/error.

`useEvent` accepts synchronous or asynchronous unsubscribe registration. Replacing
an event/subscriber or unmounting immediately disables delivery from the old
subscription. A cleanup function that arrives afterward is invoked once.
