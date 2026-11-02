import type { GeneratedBytesRoute, GeneratedFieldsRoute } from './global.js';
import type { LiveSchemaDocument, LiveSchemaEntry, FrameSchemaNative } from './live-schema.js';
import type { FrameCodec } from './public.js';

// 구현체는 전부 arrow 함수(const refreshLiveSchema = () => {...})라 this 에 의존하지
// 않는다. 계약에 this: void 를 명시해 구조 분리/콜백 전달 시에도 this 스코핑이
// 어긋나지 않음을 타입으로 고정한다(unbound-method 게이트의 해법이기도 하다).
export type FrameSchemaRuntime = {
  refreshLiveSchema(): Map<string, LiveSchemaEntry>;
  readLiveSchemaDocument(): LiveSchemaDocument;
  lookupCachedLiveSchemaEntry(command: string): LiveSchemaEntry | undefined;
  /** (T0-3) 세대 불일치 시 live schema 캐시를 재동기화한다(미노출 호스트는 no-op). */
  resyncIfStale(): void;
  /**
   * (T0-3 후속) live schema 재조회 때마다 오르는 에포크 — 파생 캐시가 세대
   * 변경을 감지해 스스로를 비우는 데 쓴다(동적 코덱 캐시 prune).
   */
  readonly resyncEpoch: number;
};

export type FrameCapabilityRuntime = {
  hasCapabilityPath: boolean;
  hasTypedPath: boolean;
  hasByIdPath: boolean;
  hasRawPath: boolean;
  hasPositionalPath: boolean;
  hasBufferPath: boolean;
  hasBatchPath: boolean;
  hasBatchByIdPath: boolean;
  ensureStaticIds(this: void): Map<string, number> | null;
  getStaticCommandName(this: void, commandId: number): string | undefined;
  getStaticCommandCapabilities(this: void, commandId: number): number;
  isVerifiedStaticId(this: void, commandId: number, command: string): boolean;
};

export type FrameEngineContext = {
  native: FrameSchemaNative;
  registry: Map<string, FrameCodec<unknown, unknown>>;
  schema: FrameSchemaRuntime;
  capabilities: FrameCapabilityRuntime;
  payloadLimit: number | undefined;
};

export type FrameDispatchRuntime = {
  dispatch<T>(this: void, command: string, args?: unknown): T;
  dispatchPromise<T>(this: void, command: string, args?: unknown): Promise<T>;
  dispatchById<T>(this: void, commandId: number, command: string, args?: unknown): T;
  dispatchPromiseById<T>(
    this: void,
    commandId: number,
    command: string,
    args?: unknown,
  ): Promise<T>;
  dispatchGeneratedFields<T>(
    this: void,
    commandId: number,
    command: string,
    args: unknown,
    fieldCount: 1 | 2 | 3,
    field0: unknown,
    field1?: unknown,
    field2?: unknown,
  ): T;
};

export type FrameRouteRuntime = {
  resolveGeneratedFieldsRoute(
    this: void,
    commandId: number,
    command: string,
    fieldCount: 1 | 2 | 3,
  ): GeneratedFieldsRoute | undefined;
  resolveGeneratedBytesRoute(
    this: void,
    commandId: number,
    command: string,
  ): GeneratedBytesRoute | undefined;
};
