import { NativeModules, Platform } from 'react-native';

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
  /** Live schema query (정적 + 동적 명령). C++ JSI 가 노출함. 동적 명령 Tier 3 fallback 에 사용. */
  getSchema?(): ArrayBuffer;
  /** B1 (RN JSI): 정적 명령 전용 C++ postcard fast path. */
  hasStaticCodec?(name: string): boolean;
  invokeTyped?(name: string, args: unknown): unknown;
  /**
   * (P0-3) cmd_id 진입 typed fast path — invokeTyped 의 u16 디스패치 변형.
   * 문자열 마샬링과 C++ 이름 비교체인을 제거한다 (JSI 횡단 2→1).
   * 미노출 구 브릿지는 invokeTyped 로 폴백한다.
   */
  invokeTypedById?(cmdId: number, args: unknown): unknown;
  /** bit 0 = typed, bit 1 = positional, bit 2 = raw scalar, bit 3 = byte buffer. */
  getCodecCapabilities?(cmdId: number): number;
  /** Tier 0 scalar entry; returns the generated public output shape. */
  invokeTypedRaw?(cmdId: number, ...fields: unknown[]): unknown;
  /**
   * (Tier 1) positional 진입 — 개별 인자를 직접 받아 JS 인자 객체 생성과
   * 프로퍼티 조회 없이 postcard 로 인코딩한다(스칼라 ≤3필드 명령만).
   * 미노출 구 브릿지는 invokeTypedById 로 폴백한다.
   */
  invokeTypedPos?(cmdId: number, ...fields: unknown[]): unknown;
  /** Single Vec<u8> fast path; input is borrowed only during the synchronous call. */
  invokeTypedBuffer?(cmdId: number, value: Uint8Array | ArrayBuffer): unknown;
  /** P0-2: 정적 명령 N 개를 단일 JSI 횡단으로 일괄 처리. */
  invokeTypedBatch?(names: string[], args: unknown[]): unknown[];
  /**
   * P0-2 byId 변형 — invokeTypedBatch 의 cmd_id 배열 진입. 배치 경로에서도
   * 문자열 마샬링 N 회를 제거한다. 미노출 구 브릿지는 invokeTypedBatch 로 폴백.
   */
  invokeTypedBatchById?(cmdIds: number[], args: unknown[]): unknown[];
  /**
   * Rust → JS 이벤트 푸시 리스너 등록. C++ EventDispatcher 가 FFI 싱크를
   * 설치하고 CallInvoker 로 JS 스레드에 마샬링한다. 콜백 인자는 JSON 문자열 —
   * @rustra/react-native subscribeEvent 래퍼가 파싱한다.
   */
  onEvent?(name: string, callback: (payloadJson: string) => void): void;
  /** 이벤트 리스너 제거. 마지막 리스너 제거 시 폴링 경로 복귀. */
  offEvent?(name: string): void;
  /** CallInvoker 없는 호스트의 수동 drain 폴백. 처리된 이벤트 수 반환. */
  drainEvents?(): number;
  /**
   * 채널 발급(타입 패리티 2단계 — Tauri ipc::Channel 모델). JS 콜백에
   * u32 핸들을 배선해 반환한다 — 커맨드 인자 channel(ChannelHandle =
   * number) 로 전달하면 Rust 가 그 핸들로 역방향 페이로드를 흘린다.
   * 호출 완료/취소 시 dropChannel(handle) 로 해제한다(핸들 재사용 없음).
   */
  createChannel?(callback: (payloadJson: string) => void): number;
  /** 채널 해제. 성공 true — 이후 동일 핸들 send 는 조용히 만료된다. */
  dropChannel?(handle: number): boolean;
};

declare global {
  // eslint-disable-next-line no-var
  var __rustraNative: RustraNative | undefined;
}

export async function installRustraJSI(): Promise<void> {
  const module = NativeModules.RustraJSI;
  if (!module) {
    throw new Error('RustraJSI native module not found. Make sure the native module is linked.');
  }
  await module.install();

  if (!globalThis.__rustraNative) {
    throw new Error('RustraJSI.install() completed but __rustraNative was not set on globalThis.');
  }
}

export function getRustraNative(): RustraNative {
  const native = globalThis.__rustraNative;
  if (!native) {
    throw new Error('RustraJSI native module not installed. Call installRustraJSI() first.');
  }
  return native;
}
