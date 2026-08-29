import type { RustraError } from './errors.js';
import type { LiveSchemaEntry } from './live-schema.js';

// ── Core types ──────────────────────────────────────────────

export type EngineClient = {
  invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T>;
  /**
   * 코드젠이 이미 알고 있는 숫자 command id를 전달하는 빠른 경로.
   * `command`도 함께 받아 엔진이 id/name 정합성을 검증하고, 미지원 또는
   * 불일치 시 안전하게 이름 기반 invoke로 폴백할 수 있게 한다.
   */
  invokeById?<T>(
    commandId: number,
    command: string,
    args?: unknown,
    options?: InvokeOptions,
  ): Promise<T>;
  /**
   * 여러 명령을 한 번에 호출한다 (P0-2). 정적 명령만 있으면 단일 JSI/FFI 횡단
   * (invokeTypedBatch)로 처리하고, 동적 명령이 섞이면 항목별 invoke 로 폴백한다.
   */
  invokeBatch?<T>(entries: BatchEntry[]): Promise<T[]>;
};

/** invokeBatch 의 입력 항목. `options.signal` 은 항목 단위 취소로 전달된다. */
export type BatchEntry = { command: string; args?: unknown; options?: InvokeOptions };

/** All first-party adapter factories guarantee the batch surface. */
export type EngineClientWithBatch = EngineClient & {
  invokeBatch<T>(entries: BatchEntry[]): Promise<T[]>;
};

/**
 * invoke 추가 옵션 (T1).
 *
 * `signal` 이 abort 되면 프라미스를 즉시 reject 한다. 네이티브가
 * `invokeAsync`/`invokeCancel` 을 노출하면 취소를 전파(전파는 JS 코덱
 * 경로만; typed/tier3 경로는 얕은 취소)하고, 그렇지 않으면 JS 프라미스만
 * 거부하는 얕은 취소로 폴백한다 — Rust 핸들러는 끝까지 실행된다.
 */
export type InvokeOptions = {
  /** (T1) AbortSignal — abort 시 Promise 를 즉시 reject 하고, 네이티브가
   *  invokeAsync/invokeCancel 을 노출하면 취소를 전파한다. */
  signal?: AbortSignal;
  /**
   * (프로덕션 준비) 호출별 타임아웃(ms). 만료 시 `transport.timeout`
   * (retryable)으로 reject 한다. 네이티브가 응답하지 않는 hang(워커 패닉,
   * FFI 데드락 등)의 유일한 JS 측 탈출구다. 지각 응답은 무시된다.
   */
  timeoutMs?: number;
};

/**
 * createRkyvV2Engine 이 반환하는 구체 엔진. EngineClient 에 더해 invokeBatch(P0-2) 를
 * 항상 지원한다 — 정적 전용이면 단일 횡단, 동적 혼합이면 항목별 라우팅.
 */
export type RkyvV2Engine = EngineClient & {
  invokeById<T>(
    commandId: number,
    command: string,
    args?: unknown,
    options?: InvokeOptions,
  ): Promise<T>;
  invokeBatch<T>(entries: BatchEntry[]): Promise<T[]>;
  /** 동적 registry 변경 뒤 엔진의 live-schema cache를 명시적으로 갱신한다. */
  refreshLiveSchema(): ReadonlyMap<string, LiveSchemaEntry>;
};

// ── rkyv V2 codec types ────────────────────────────────────

/**
 * rkyv V2 코덱 — 각 명령의 바이너리 인코딩/디코딩을 담당합니다.
 * 코드젠이 명령별로 자동 생성합니다.
 */
export type RkyvV2Codec<I, O> = {
  commandId: number;
  encode(args: I): ArrayBuffer;
  /**
   * (선택) 재사용 버퍼에 직접 인코딩한다. 대형 페이로드(≥64KiB)에서 매 호출
   * 신규 할당이 지배적이었다(실측: 1MiB 할당 ~42µs vs 재사용 memcpy 20µs).
   * 버퍼가 부족하면 내부적으로 정확한 크기로 재할당하고 그 버퍼를 반환한다 —
   * 호출자는 반환 subarray를 다음 호출에 그대로 재전달하면 된다. 미구현
   * 코덱(레거시)에서는 encode 와 동일한 새 ArrayBuffer 를 돌려준다.
   */
  encodeInto?(args: I, reuse?: Uint8Array): Uint8Array;
  decode(buf: ArrayBuffer): { ok: boolean; result?: O; error?: RustraError };
};

export { createComplexCodec } from './complex-codec.js';
export type { ComplexCodecOptions, ComplexSchema } from './complex-codec.js';

/**
 * rkyv V2 네이티브 인터페이스 — 플랫폼별 FFI 브릿지가 구현합니다.
 */
export type RkyvV2Native = {
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
};

/**
 * 통합 네이티브 인터페이스 — JSI/FFI 브릿지가 노출하는 모든 메서드.
 * 각 어댑터는 필요한 메서드만 사용합니다.
 */
export type RustraNative = {
  invoke(payload: ArrayBuffer): ArrayBuffer;
  invokeMsgpack(payload: ArrayBuffer): ArrayBuffer;
  invokeBincode(payload: ArrayBuffer): ArrayBuffer;
  invokePostcard(payload: ArrayBuffer): ArrayBuffer;
  invokeRkyv(payload: ArrayBuffer): ArrayBuffer;
  invokeHybrid(payload: ArrayBuffer): ArrayBuffer;
  invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer;
  invokeRaw(payload: ArrayBuffer): ArrayBuffer;
  noop(payload: ArrayBuffer): ArrayBuffer;
  /** Live schema query (정적 + 동적 명령). JSI/FFI 가 노출하면 사용. */
  getSchema?(): ArrayBuffer;
  /** B1 (RN JSI): 정적 명령 C++ postcard fast path. JSI 가 노출하면 사용. */
  hasStaticCodec?(name: string): boolean;
  invokeTyped?(name: string, args: unknown): unknown;
  /**
   * (P0-3) cmd_id 진입 typed fast path — `invokeTyped` 의 u16 디스패치 변형.
   * 문자열 마샬링과 C++ 이름 비교체인을 제거한다 (JSI 횡단 2→1, 문자열 2→0).
   * 미노출 구 네이티브는 이름 기반 `invokeTyped` 로 폴백한다.
   */
  invokeTypedById?(cmdId: number, args: unknown): unknown;
  /**
   * Generated command capability mask keyed by numeric command id.
   * bit 0 = typed, bit 1 = positional, bit 2 = raw scalar,
   * bit 3 = a single schema-proven byte buffer.
   */
  getCodecCapabilities?(cmdId: number): number;
  /** Tier 0: scalar fields and scalar/unit output without postcard conversion. */
  invokeTypedRaw?(cmdId: number, ...fields: unknown[]): unknown;
  /** Tier 1: one to three generated scalar/string fields without object reads. */
  invokeTypedPos?(cmdId: number, ...fields: unknown[]): unknown;
  /**
   * Tier 0.5: one schema-proven `Vec<u8>` field. Native code only borrows the
   * input for this synchronous call and returns a JS-owned result.
   */
  invokeTypedBuffer?(cmdId: number, value: Uint8Array | ArrayBuffer): unknown;
  /** P0-2: 정적 명령 N 개를 단일 횡단으로 일괄 처리 (RN JSI). */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
  /**
   * P0-2 byId 변형 — `invokeTypedBatch` 의 cmd_id 배열 진입. 배치 경로에서도
   * 문자열 마샬링 N 회를 제거한다. 미노출 구 네이티브는 이름 기반
   * `invokeTypedBatch` 로 폴백한다.
   */
  invokeTypedBatchById?(cmdIds: number[], args: unknown[]): unknown[];
  /**
   * Rust → JS 이벤트 푸시 리스너 등록(RN JSI). `payloadJson` 은 **JSON 문자열**로
   * 전달된다 — TS 래퍼(`@rustra/react-native` `subscribeEvent`)가
   * `JSON.parse` 1회로 객체로 복원한다. 등록 시점에 C++ 이 FFI 싱크를
   * 설치하고, 이후 Rust `emit` 은 CallInvoker 로 JS 스레드에 마샬링되어
   * 콜백을 호출한다.
   */
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  /** 등록된 이벤트 리스너 제거(RN JSI). 마지막 리스너 제거 시 폴링 경로 복귀. */
  offEvent?(name: string): void;
  /**
   * CallInvoker 없는 호스트의 JS 폴링 drain(RN JSI). 처리된 이벤트 수 반환.
   * CallInvoker 경로가 켜져 있으면 대개 호출 즉시 0(자동 drain 됨).
   */
  drainEvents?(): number;
  /** (T1) 진행 중 async 호출 취소 — invokeAsync 가 반환한 invocation id 를 넘긴다. */
  invokeCancel?(invocationId: number): boolean;
};
