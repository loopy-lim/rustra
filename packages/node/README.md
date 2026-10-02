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

Runtime candidates are ordered by modification time and checked against the generated
contract, falling back to the next compatible candidate. After transpile/bundle, the client
additionally looks for the same Cargo target in the parent of the current working
directory. If the deployment layout differs, just set
`RUSTRA_NODE_BINARY=/absolute/path/to/app`.

For manual bootstraps, relative `commandCandidates` and `binaryName` discovery start
from `spawnOptions.cwd` (a string or file URL), defaulting to `process.cwd()`.
An explicit bare `command` still uses the child process's `PATH`. Missing-runtime
errors show the working directory and checked candidate paths.

## Persistent state and events

The default `node: {}` invokes a fresh process for each command. For stateful services,
use `node: { "persistent": true }`; the generated entry starts one `serve` process and
reuses it. Set `node.args` for a custom daemon flag, such as `["--serve"]`. The producer
must implement NDJSON request ids, `__rustra_contract`, `__rustra_capabilities`, and
`__drainEvents`; the current `rustra init` scaffold includes this protocol.

Schemas declaring events automatically select a persistent client. Import its
`subscribeEvent` alongside generated commands; invocation and subscription share the
contract-verified runtime. `rustra.subscribeEvent()` is also available on a manually
created `createNodeBootstrap({ persistent: true, ... })`.

Call `rustra.dispose()` when the service ends; it releases the process and subscriptions.
`reload()` preserves subscriptions while replacing the process. Contract/capability
probes time out after 5 seconds by default; `readinessTimeoutMs` changes that bound.

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
default one-shot path, 16.86µs on the persistent loop, and 1.26µs on N-API Frame. Use
the default path for CLIs and low-frequency work, `createNodeLoopTransport` for servers,
and an N-API addon for high-frequency hot paths. A runnable comparison of the generated
client, explicit one-shot JSON, persistent JSON, persistent binary, and N-API paths
is in [`node-performance.ts`](../../examples/calculator/apps/node-performance.ts).
