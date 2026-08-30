English | [한국어](./README.ko.md)

# @rustra/node

Adapter that auto-discovers the Rustra runtime in Node environments and connects it to the shared `EngineClient`.

## Zero-config default path

Leave only an empty host block in `rustra.json`.

```json
{ "schema": "./generated/schema.json", "output": "./src/generated", "node": {} }
```

Codegen locates the default binary and target directory via Cargo metadata and creates
`generated/node.ts`. The application is left with no engine creation or `configure()`.

```ts
import { addNumbers } from './generated/node.js';

const result = await addNumbers({ a: 20, b: 22 });
```

Release generated output is used first, falling back to Debug. After transpile/bundle, it
additionally looks for the same Cargo target in the parent of the current working
directory. If the deployment layout differs, just set
`RUSTRA_NODE_BINARY=/absolute/path/to/app`.

## Public API

```ts
type NodeInvokeTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
};

type NodeEngineClient = {
  invoke<T>(command: string, args?: unknown): Promise<T>;
};

function createNodeEngine(transport: NodeInvokeTransport): NodeEngineClient;
```

## Usage examples

### subprocess-based

```ts
import { createNodeEngine } from '@rustra/node';
import { spawn } from 'node:child_process';

const engine = createNodeEngine({
  async invoke(command, args) {
    const child = spawn('cargo', ['run', '-p', 'my-crate', '--', 'invoke']);
    // Communicates over JSON stdin/stdout
    return sendAndReceive(child, { command, args });
  },
});
```

### napi-rs-based

```ts
import { createNodeEngine } from '@rustra/node';
import { invoke as nativeInvoke } from 'my-crate-napi';

const engine = createNodeEngine({
  invoke(command, args) {
    return nativeInvoke(command, args);
  },
});
```

Manual `createNodeEngine` and the process/loop transport injection APIs remain available
for exceptions such as multiple runtimes and custom N-API deployments. Because the
default generated entry point uses the standard one-shot stdio protocol, deployments that
need N-API level performance should opt into a separate native addon.

## Choosing a path for the performance you need

Measured on 2026-08-24 macOS arm64 Release, the generated API averaged 2.76ms on the
default one-shot path, 16.86µs on the persistent loop, and 1.26µs on N-API rkyv V2. Use
the default path for CLIs and low-frequency work, `createNodeLoopTransport` for servers,
and an N-API addon for high-frequency hot paths. A runnable comparison of the three paths
is in [`node-performance.ts`](../../examples/calculator/apps/node-performance.ts).
