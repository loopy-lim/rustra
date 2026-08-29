import type { EngineClient } from './public.js';

export const invokeByIdSync = Symbol.for('dev.rustra.types.v0.4.0.invokeByIdSync');
export const invokeGeneratedFieldsSync = Symbol.for(
  'dev.rustra.types.v0.4.0.invokeGeneratedFieldsSync',
);
export const resolveGeneratedFieldsSync = Symbol.for(
  'dev.rustra.types.v0.4.0.resolveGeneratedFieldsSync',
);
export const invokeGeneratedBytesSync = Symbol.for(
  'dev.rustra.types.v0.4.0.invokeGeneratedBytesSync',
);
export const resolveGeneratedBytesSync = Symbol.for(
  'dev.rustra.types.v0.4.0.resolveGeneratedBytesSync',
);
export const CODEC_TYPED = 1 << 0;
export const CODEC_POSITIONAL = 1 << 1;
export const CODEC_RAW = 1 << 2;
export const CODEC_BUFFER = 1 << 3;

export function isNativeByteBuffer(value: unknown): value is Uint8Array | ArrayBuffer {
  if (typeof ArrayBuffer === 'undefined' || typeof value !== 'object' || value === null)
    return false;
  if (value instanceof ArrayBuffer) return true;
  return (
    ArrayBuffer.isView(value) && (value as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1
  );
}

export type GeneratedFieldsRoute = (
  args: unknown,
  field0: unknown,
  field1?: unknown,
  field2?: unknown,
) => unknown;
export type GeneratedBytesRoute = (args: unknown, value: unknown) => unknown;
export type CachedGeneratedFieldsRoute = {
  command: string;
  fieldCount: 1 | 2 | 3;
  invoke: GeneratedFieldsRoute;
};
export type CachedGeneratedBytesRoute = { command: string; invoke: GeneratedBytesRoute };
export type GeneratedCommand<TInput, TOutput> = ((
  input: TInput,
  options?: import('./public.js').InvokeOptions,
) => Promise<TOutput>) & { commandId: string };

export type InternalEngineClient = EngineClient & {
  [invokeByIdSync]?<T>(commandId: number, command: string, args?: unknown): T;
  [invokeGeneratedFieldsSync]?<T>(
    commandId: number,
    command: string,
    args: unknown,
    fieldCount: 1 | 2 | 3,
    field0: unknown,
    field1?: unknown,
    field2?: unknown,
  ): T;
  [resolveGeneratedFieldsSync]?(
    commandId: number,
    command: string,
    fieldCount: 1 | 2 | 3,
  ): GeneratedFieldsRoute | undefined;
  [invokeGeneratedBytesSync]?<T>(
    commandId: number,
    command: string,
    args: unknown,
    value: unknown,
  ): T;
  [resolveGeneratedBytesSync]?(commandId: number, command: string): GeneratedBytesRoute | undefined;
};

export const runtime: {
  engine: InternalEngineClient | null;
  engineInitializer?: () => EngineClient | Promise<EngineClient>;
  engineInitialization?: Promise<InternalEngineClient>;
  engineGeneration: number;
  generatedFieldsRoutes: Array<CachedGeneratedFieldsRoute | null | undefined>;
  generatedBytesRoutes: Array<CachedGeneratedBytesRoute | null | undefined>;
} = (() => {
  const key = Symbol.for('dev.rustra.types.v0.4.0.runtimeState');
  const global = globalThis as Record<PropertyKey, unknown>;
  const existing = global[key] as typeof runtime | undefined;
  if (existing) return existing;
  const value = {
    engine: null,
    engineGeneration: 0,
    generatedFieldsRoutes: [],
    generatedBytesRoutes: [],
  } as typeof runtime;
  global[key] = value;
  return value;
})();

export function resetConfiguredRoutes(): void {
  runtime.engineGeneration += 1;
  runtime.generatedFieldsRoutes = [];
  runtime.generatedBytesRoutes = [];
}
