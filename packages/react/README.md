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
`useMutation`, `useEvent`, and `useSuspenseCommand`. React is a peer dependency;
configure the platform-specific Rustra engine before rendering the provider.

`useSuspenseCommand(commandFn, input?, options?)` is the Suspense-compatible read:
it suspends by throwing the in-flight promise until the command resolves, then
returns the value directly (a rejection is re-thrown to the nearest error
boundary). Results live in a module-level cache keyed by command name + serialized
input for the whole session — there is no eviction — so call
`invalidateCommands(commandName?)` to drop one command's entries (or, with no
argument, the whole cache) and make the next render re-invoke.

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
