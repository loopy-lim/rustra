import { RustraCommandError } from '@rustra/types';
import type { NodeBootstrapOptions, NodeProcessTransport } from './node-core.js';
import { createNodeLoopTransport } from './node-loop.js';

export function createNodePersistentTransport(
  command: string,
  options: NodeBootstrapOptions,
): NodeProcessTransport {
  const loop = createNodeLoopTransport({
    command,
    args: options.args ?? ['serve'],
    spawnOptions: options.spawnOptions,
  });
  return Object.assign(loop, {
    async getContractHash() {
      const hash = await loop.invoke('__rustra_contract');
      if (typeof hash !== 'string' || !hash)
        throw new RustraCommandError(
          'contract.unenforceable',
          'Persistent Node runtime returned an invalid contract hash',
        );
      return hash;
    },
  });
}

export async function awaitNodeReadiness<T>(
  operation: () => T | Promise<T>,
  transport: NodeProcessTransport,
  options: NodeBootstrapOptions,
  endpoint: string,
  code: 'contract.unenforceable' | 'event.unavailable',
): Promise<T> {
  const timeoutMs = options.readinessTimeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new RustraCommandError(
      'command.invalid_args',
      'readinessTimeoutMs must be a positive finite number',
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new RustraCommandError(
              code,
              `Node runtime ${endpoint} probe timed out after ${timeoutMs}ms; rebuild a compatible Rustra serve host or adjust readinessTimeoutMs.`,
            ),
          );
          transport.dispose();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyNodeEventRuntime(
  transport: NodeProcessTransport,
  options: NodeBootstrapOptions,
) {
  try {
    const capabilities = (await awaitNodeReadiness(
      () => transport.invoke('__rustra_capabilities'),
      transport,
      options,
      '__rustra_capabilities',
      'event.unavailable',
    )) as { events?: unknown };
    if (capabilities?.events !== 'polling' && capabilities?.events !== 'push')
      throw new Error('runtime did not advertise event delivery');
  } catch (error) {
    if (error instanceof RustraCommandError && error.code === 'event.unavailable') throw error;
    throw new RustraCommandError(
      'event.unavailable',
      'Persistent Node events require a Rustra serve runtime with __rustra_capabilities and __drainEvents; rebuild the Rust host with the current scaffold.',
      false,
      error,
    );
  }
}
