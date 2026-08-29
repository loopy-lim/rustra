import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  configureLazy,
  ensureConfigured,
  RustraCommandError,
  RustraErrorCode,
  type EngineClientWithBatch,
} from '@rustra/types';
import {
  createNodeEngine,
  createNodeProcessTransport,
  type NodeBootstrap,
  type NodeBootstrapOptions,
  type NodeProcessTransport,
} from './node-core.js';

function resolveNodeRuntime(options: NodeBootstrapOptions): string {
  const explicit = process.env.RUSTRA_NODE_BINARY ?? options.command;
  if (explicit) return explicit;
  const candidates = [...(options.commandCandidates ?? [])];
  if (options.binaryName) {
    const executable = options.binaryName + (process.platform === 'win32' ? '.exe' : '');
    let current = resolve(process.cwd());
    while (true) {
      candidates.push(resolve(current, 'target', 'release', executable));
      candidates.push(resolve(current, 'target', 'debug', executable));
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const inferred = candidates.find((candidate) => existsSync(candidate));
  if (inferred) return inferred;
  throw new RustraCommandError(
    RustraErrorCode.TransportUnavailable,
    'No Rustra Node runtime was found. Build the inferred Cargo binary, or set RUSTRA_NODE_BINARY to its absolute path.',
  );
}

export function createNodeBootstrap(options: NodeBootstrapOptions = {}): NodeBootstrap {
  let transport: NodeProcessTransport | undefined;
  configureLazy(async () => {
    transport = createNodeProcessTransport({
      command: resolveNodeRuntime(options),
      args: options.args,
      spawnOptions: options.spawnOptions,
    });
    if (options.contractHash !== undefined) {
      try {
        const nativeHash = await transport.getContractHash();
        if (nativeHash !== options.contractHash)
          throw new RustraCommandError(
            'contract.mismatch',
            `contract hash mismatch: native="${nativeHash.slice(0, 16)}…" vs expected="${options.contractHash.slice(0, 16)}…"`,
          );
      } catch (error) {
        transport.dispose();
        transport = undefined;
        if (
          error instanceof RustraCommandError &&
          ['contract.mismatch', 'contract.unenforceable'].includes(error.code)
        )
          throw error;
        throw new RustraCommandError(
          'contract.unenforceable',
          'Node runtime does not expose the __rustra_contract endpoint; rebuild the Rust host with the current Rustra scaffold.',
          false,
          error,
        );
      }
    }
    return createNodeEngine(transport);
  });
  return {
    ready: () => ensureConfigured() as Promise<EngineClientWithBatch>,
    dispose() {
      transport?.dispose();
      transport = undefined;
    },
  };
}
