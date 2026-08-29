import { invokeByIdWithTimeout, invokeWithTimeout } from './cancel.js';
import type { EngineClient, InvokeOptions } from './public.js';
import {
  invokeByIdSync,
  resetConfiguredRoutes,
  runtime,
  type InternalEngineClient,
} from './global-state.js';

export function configure(engine: EngineClient): void {
  runtime.engine = engine;
  runtime.engineInitializer = undefined;
  runtime.engineInitialization = undefined;
  resetConfiguredRoutes();
}

export function configureLazy(initializer: () => EngineClient | Promise<EngineClient>): void {
  runtime.engine = null;
  runtime.engineInitializer = initializer;
  runtime.engineInitialization = undefined;
  resetConfiguredRoutes();
}

export function isLazyConfigured(): boolean {
  return runtime.engineInitializer !== undefined;
}

export function ensureConfigured(): Promise<EngineClient> {
  if (runtime.engine) return Promise.resolve(runtime.engine);
  if (!runtime.engineInitializer)
    return Promise.reject(
      new Error(
        'Rustra not configured. Call configure(engine), or import the generated React Native entry that registers lazy setup.',
      ),
    );
  if (!runtime.engineInitialization) {
    const initializer = runtime.engineInitializer;
    const generation = runtime.engineGeneration;
    const initialization = Promise.resolve()
      .then(initializer)
      .then((engine) => {
        if (runtime.engineGeneration !== generation || runtime.engineInitializer !== initializer)
          return runtime.engine ?? ensureConfigured();
        configure(engine);
        return engine as InternalEngineClient;
      })
      .catch((error) => {
        if (runtime.engineInitialization === initialization)
          runtime.engineInitialization = undefined;
        throw error;
      });
    runtime.engineInitialization = initialization;
  }
  return runtime.engineInitialization;
}

export function resolveCommandId(commandFn: (...args: never[]) => unknown): string {
  const withId = commandFn as { commandId?: unknown };
  if (typeof withId.commandId === 'string' && withId.commandId.length > 0) return withId.commandId;
  if (typeof commandFn.name === 'string' && commandFn.name.length > 0) return commandFn.name;
  throw new Error(
    'Command function must have a commandId or name property (use generated commands or pass a named function)',
  );
}

export function invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
  const engine = runtime.engine;
  if (!engine) {
    if (isLazyConfigured()) return ensureConfigured().then(() => invoke<T>(command, args, options));
    return Promise.reject(new Error('Rustra not configured. Call configure(engine) first.'));
  }
  return invokeWithTimeout(engine, command, args, options);
}

export function invokeGenerated<T>(
  commandId: number,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T> {
  const engine = runtime.engine;
  if (!engine) {
    if (isLazyConfigured())
      return ensureConfigured().then(() => invokeGenerated<T>(commandId, command, args, options));
    throw new Error('Rustra not configured. Call configure(engine) first.');
  }
  const syncInvoke = engine[invokeByIdSync];
  if (options === undefined && syncInvoke) {
    try {
      return Promise.resolve(syncInvoke<T>(commandId, command, args));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  if (!engine.invokeById) return invokeWithTimeout(engine, command, args, options);
  return invokeByIdWithTimeout(engine, commandId, command, args, options);
}
