import { RustraCommandError } from './errors.js';
import { resolveSyncBinding, runtime } from './global-state.js';

/**
 * Bind a generated synchronous command on the configured engine. Bootstrap must
 * already be ready. Unknown/async commands and mutable or unverifiable hosts are
 * rejected; this API never starts lazy initialization or falls back to a Promise.
 * Errors are thrown synchronously. Bindings follow configure/reload/disposal.
 */
export function bindSync<I, O>(command: string): (input: I) => O {
  let generation = -1;
  let route: (input: unknown) => unknown;
  const resolve = () => {
    const engine = runtime.engine;
    const resolver = engine?.[resolveSyncBinding];
    if (!resolver) {
      throw new RustraCommandError(
        'sync.unavailable',
        'A configured synchronous engine is required; await bootstrap.ready() before bindSync().',
      );
    }
    const current = runtime.engineGeneration;
    const resolved = resolver.call(engine, command);
    if (current !== runtime.engineGeneration || engine !== runtime.engine) {
      throw new RustraCommandError(
        'sync.unavailable',
        'Engine changed while binding synchronously.',
      );
    }
    route = resolved;
    generation = current;
  };
  resolve();
  return (input: I): O => {
    if (generation !== runtime.engineGeneration) resolve();
    // Call-local snapshot: nested invocation/reconfiguration cannot replace the
    // route midway through this call. The next call observes the new generation.
    const invoke = route;
    return invoke(input) as O;
  };
}
