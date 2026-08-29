import type { GeneratedBytesRoute, GeneratedFieldsRoute } from './global.js';
import type { LiveSchemaDocument, LiveSchemaEntry, RkyvV2SchemaNative } from './live-schema.js';
import type { BatchEntry, InvokeOptions, RkyvV2Codec } from './public.js';

export type RkyvSchemaRuntime = {
  refreshLiveSchema(): Map<string, LiveSchemaEntry>;
  readLiveSchemaDocument(): LiveSchemaDocument;
  lookupCachedLiveSchemaEntry(command: string): LiveSchemaEntry | undefined;
  /** (T0-3) FFI 세대 비교 게이트 — 불일치 시 live schema 재조회(스테일 캐시 차단). */
  generationGate(): void;
};

export type RkyvCapabilityRuntime = {
  hasCapabilityPath: boolean;
  hasTypedPath: boolean;
  hasByIdPath: boolean;
  hasRawPath: boolean;
  hasPositionalPath: boolean;
  hasBufferPath: boolean;
  hasBatchPath: boolean;
  hasBatchByIdPath: boolean;
  ensureStaticIds(): Map<string, number> | null;
  getStaticCommandName(commandId: number): string | undefined;
  getStaticCommandCapabilities(commandId: number): number;
  isVerifiedStaticId(commandId: number, command: string): boolean;
};

export type RkyvEngineContext = {
  native: RkyvV2SchemaNative;
  registry: Map<string, RkyvV2Codec<unknown, unknown>>;
  schema: RkyvSchemaRuntime;
  capabilities: RkyvCapabilityRuntime;
  payloadLimit: number | undefined;
};

export type RkyvDispatchRuntime = {
  dispatch<T>(command: string, args?: unknown): T;
  dispatchPromise<T>(command: string, args?: unknown): Promise<T>;
  dispatchById<T>(commandId: number, command: string, args?: unknown): T;
  dispatchPromiseById<T>(commandId: number, command: string, args?: unknown): Promise<T>;
  dispatchGeneratedFields<T>(
    commandId: number,
    command: string,
    args: unknown,
    fieldCount: 1 | 2 | 3,
    field0: unknown,
    field1?: unknown,
    field2?: unknown,
  ): T;
};

export type RkyvRouteRuntime = {
  resolveGeneratedFieldsRoute(
    commandId: number,
    command: string,
    fieldCount: 1 | 2 | 3,
  ): GeneratedFieldsRoute | undefined;
  resolveGeneratedBytesRoute(commandId: number, command: string): GeneratedBytesRoute | undefined;
};

export type RkyvBatchEntry = BatchEntry;
export type RkyvInvokeOptions = InvokeOptions;
