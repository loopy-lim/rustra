import type { EngineClient } from './public.js';

/**
 * @internal — engine dispatch protocol: versioned `Symbol.for` keys the facade
 * uses to probe an engine's byId/positional/bytes fast paths (see
 * InternalEngineClient). Plumbing between this package's facade and its
 * engines; not public API.
 */
export const invokeByIdSync = Symbol.for('dev.rustra.types.v0.4.0.invokeByIdSync');
/** @internal — dispatch protocol key, see {@link invokeByIdSync}. */
export const invokeGeneratedFieldsSync = Symbol.for(
  'dev.rustra.types.v0.4.0.invokeGeneratedFieldsSync',
);
/** @internal — dispatch protocol key, see {@link invokeByIdSync}. */
export const resolveGeneratedFieldsSync = Symbol.for(
  'dev.rustra.types.v0.4.0.resolveGeneratedFieldsSync',
);
/** @internal — dispatch protocol key, see {@link invokeByIdSync}. */
export const invokeGeneratedBytesSync = Symbol.for(
  'dev.rustra.types.v0.4.0.invokeGeneratedBytesSync',
);
/** @internal — dispatch protocol key, see {@link invokeByIdSync}. */
export const resolveGeneratedBytesSync = Symbol.for(
  'dev.rustra.types.v0.4.0.resolveGeneratedBytesSync',
);
/** @internal — capability bitmask consumed by the engine fast-path dispatch (see InternalEngineClient). */
export const CODEC_TYPED = 1 << 0;
export const CODEC_POSITIONAL = 1 << 1;
export const CODEC_RAW = 1 << 2;
export const CODEC_BUFFER = 1 << 3;

/** @internal — byte-field detection used by the engine dispatch routes; not public API. */
export function isNativeByteBuffer(value: unknown): value is Uint8Array | ArrayBuffer {
  if (typeof ArrayBuffer === 'undefined' || typeof value !== 'object' || value === null)
    return false;
  if (value instanceof ArrayBuffer) return true;
  return (
    ArrayBuffer.isView(value) && (value as { BYTES_PER_ELEMENT?: unknown }).BYTES_PER_ELEMENT === 1
  );
}

/** @internal — shapes behind the engine fast-path protocol; not public API. */
export type GeneratedFieldsRoute = (
  args: unknown,
  field0: unknown,
  field1?: unknown,
  field2?: unknown,
) => unknown;
/** @internal — see {@link GeneratedFieldsRoute}. */
export type GeneratedBytesRoute = (args: unknown, value: unknown) => unknown;
/** @internal — see {@link GeneratedFieldsRoute}. */
export type CachedGeneratedFieldsRoute = {
  command: string;
  fieldCount: 1 | 2 | 3;
  invoke: GeneratedFieldsRoute;
};
/** @internal — see {@link GeneratedFieldsRoute}. */
export type CachedGeneratedBytesRoute = { command: string; invoke: GeneratedBytesRoute };
/** @internal — the commandId-carrying function shape codegen emits; not public API. */
export type GeneratedCommand<TInput, TOutput> = ((
  input: TInput,
  options?: import('./public.js').InvokeOptions,
) => Promise<TOutput>) & { commandId: string };

/** @internal — engine contract extended with the optional sync fast-path symbols; not public API. */
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

/** @internal — module-global engine/route registry (shared across duplicate copies via Symbol.for). Not public API. */
export const runtime: {
  engine: InternalEngineClient | null;
  engineInitializer?: () => EngineClient | Promise<EngineClient>;
  engineInitialization?: Promise<InternalEngineClient>;
  /**
   * @internal — R08 소유권: 현재 pending lazy 등록이 ensureConfigured 에 의해
   * 소비를 시작했는지. 소비 전 경쟁 등록만 loud-fail 한다(소비 뒤 교체·복구는
   * 기존 계약 유지). configure/configureLazy 의 새 등록에서 리셋된다.
   */
  engineInitializerConsumed: boolean;
  /** @internal — R08 소유권: pending 등록자 식별(진단 메시지용). */
  engineOwnerId?: string;
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
    engineInitializerConsumed: false,
    generatedFieldsRoutes: [],
    generatedBytesRoutes: [],
  } as typeof runtime;
  global[key] = value;
  return value;
})();

/** @internal — invalidates cached engine fast-path routes on (re)configure; not public API. */
export function resetConfiguredRoutes(): void {
  runtime.engineGeneration += 1;
  runtime.generatedFieldsRoutes = [];
  runtime.generatedBytesRoutes = [];
}
