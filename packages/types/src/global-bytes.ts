import { invokeGeneratedBytesSync, runtime, resolveGeneratedBytesSync } from './global-state.js';
import { ensureConfigured, isLazyConfigured } from './global-config.js';
import { invokeGeneratedFields1 } from './global-fields.js';
import type { InvokeOptions } from './public.js';

export function invokeGeneratedBytes<T>(
  commandId: number,
  command: string,
  args: unknown,
  value: Uint8Array | ArrayBuffer | number[],
  options?: InvokeOptions,
): Promise<T> {
  const engine = runtime.engine;
  if (!engine) {
    if (isLazyConfigured())
      return ensureConfigured().then(() =>
        invokeGeneratedBytes<T>(commandId, command, args, value, options),
      );
    throw new Error('Rustra not configured. Call configure(engine) first.');
  }
  if (options === undefined) {
    let route = runtime.generatedBytesRoutes[commandId];
    if (route === undefined) {
      const invoke = engine[resolveGeneratedBytesSync]?.(commandId, command);
      route = invoke ? { command, invoke } : null;
      runtime.generatedBytesRoutes[commandId] = route;
    }
    if (route && route.command === command) {
      try {
        return Promise.resolve(route.invoke(args, value) as T);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const syncInvoke = engine[invokeGeneratedBytesSync];
    if (syncInvoke) {
      try {
        return Promise.resolve(syncInvoke<T>(commandId, command, args, value));
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }
  return invokeGeneratedFields1<T>(commandId, command, args, value, options);
}
