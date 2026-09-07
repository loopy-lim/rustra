/**
 * Codegen import contract — generated clients import these helpers by name
 * (see rustra codegen). They are public in name only; signatures follow the
 * generated calling convention and may change with codegen versions.
 */
import {
  invokeGeneratedFieldsSync,
  resolveGeneratedFieldsSync,
  runtime,
  type GeneratedCommand,
  type GeneratedFieldsRoute,
} from './global-state.js';
import { ensureConfigured, isLazyConfigured, invokeGenerated } from './global-config.js';
import { RustraCommandError, RustraErrorCode } from './errors.js';
import type { InvokeOptions } from './public.js';

function invokeRoute<T>(route: GeneratedFieldsRoute, args: unknown, fields: unknown[]): Promise<T> {
  try {
    return Promise.resolve(route(args, fields[0], fields[1], fields[2]) as T);
  } catch (error) {
    return Promise.reject(error);
  }
}

function invokeFields<T>(
  commandId: number,
  command: string,
  args: unknown,
  fields: unknown[],
  count: 1 | 2 | 3,
  options?: InvokeOptions,
): Promise<T> {
  const engine = runtime.engine;
  if (!engine) {
    if (isLazyConfigured())
      return ensureConfigured().then(() =>
        invokeFields<T>(commandId, command, args, fields, count, options),
      );
    return Promise.reject(
      new RustraCommandError(
        RustraErrorCode.TransportUnavailable,
        'Rustra not configured. Call configure(engine) first.',
      ),
    );
  }
  if (options === undefined) {
    let route = runtime.generatedFieldsRoutes[commandId];
    if (route === undefined) {
      const invoke = engine[resolveGeneratedFieldsSync]?.(commandId, command, count);
      route = invoke ? { command, fieldCount: count, invoke } : null;
      runtime.generatedFieldsRoutes[commandId] = route;
    }
    if (route && route.command === command && route.fieldCount === count)
      return invokeRoute<T>(route.invoke, args, fields);
    const syncInvoke = engine[invokeGeneratedFieldsSync];
    if (syncInvoke) {
      try {
        return Promise.resolve(
          syncInvoke<T>(commandId, command, args, count, fields[0], fields[1], fields[2]),
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }
  }
  return invokeGenerated<T>(commandId, command, args, options);
}

/** @internal — codegen import contract; see note atop global-fields.ts. */
export function invokeGeneratedFields1<T>(
  commandId: number,
  command: string,
  args: unknown,
  field0: unknown,
  options?: InvokeOptions,
): Promise<T> {
  return invokeFields(commandId, command, args, [field0], 1, options);
}
/** @internal — codegen import contract; see note atop global-fields.ts. */
export function invokeGeneratedFields2<T>(
  commandId: number,
  command: string,
  args: unknown,
  field0: unknown,
  field1: unknown,
  options?: InvokeOptions,
): Promise<T> {
  return invokeFields(commandId, command, args, [field0, field1], 2, options);
}
/** @internal — codegen import contract; see note atop global-fields.ts. */
export function invokeGeneratedFields3<T>(
  commandId: number,
  command: string,
  args: unknown,
  field0: unknown,
  field1: unknown,
  field2: unknown,
  options?: InvokeOptions,
): Promise<T> {
  return invokeFields(commandId, command, args, [field0, field1, field2], 3, options);
}

/** @internal — codegen import contract; see note atop global-fields.ts. */
export function createGeneratedFields2<TInput extends object, TOutput>(
  commandId: number,
  command: string,
  field0Key: keyof TInput,
  field1Key: keyof TInput,
  functionName = command,
): GeneratedCommand<TInput, TOutput> {
  let routeGeneration = -1;
  let route: GeneratedFieldsRoute | null = null;
  const generated = ((input: TInput, options?: InvokeOptions): Promise<TOutput> => {
    const field0 = input[field0Key];
    const field1 = input[field1Key];
    if (!runtime.engine || options !== undefined)
      return invokeGeneratedFields2<TOutput>(commandId, command, input, field0, field1, options);
    if (routeGeneration !== runtime.engineGeneration) {
      route = runtime.engine[resolveGeneratedFieldsSync]?.(commandId, command, 2) ?? null;
      routeGeneration = runtime.engineGeneration;
    }
    if (route) return invokeRoute<TOutput>(route, input, [field0, field1]);
    return invokeGeneratedFields2<TOutput>(commandId, command, input, field0, field1);
  }) as GeneratedCommand<TInput, TOutput>;
  Object.defineProperty(generated, 'name', { configurable: true, value: functionName });
  generated.commandId = command;
  return generated;
}
