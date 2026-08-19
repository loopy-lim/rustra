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
`useMutation`, and `useEvent`. React is a peer dependency; configure the
platform-specific Rustra engine before rendering the provider.
