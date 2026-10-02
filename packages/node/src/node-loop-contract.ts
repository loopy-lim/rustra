import type { NodeInvokeTransport } from './node-core.js';
import type { NodeChannelBytesFrame } from './node-binary-framing.js';

export type LoopResponseFrame = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  events?: Array<{ name: string; payload: unknown }>;
};

export type HandshakeFrame = LoopResponseFrame & {
  binary?: boolean;
  events?: string;
  channelBytes?: boolean;
};
export type NodeLoopTransport = NodeInvokeTransport & {
  drainEvents(): Promise<Array<{ name: string; payload: unknown }>>;
  dispose(): void;
  readonly pid: number | null;
  /** 'ndjson' = 레거시 라인 프로토콜, 'binary' = length-prefixed Frame (트랙 D). */
  readonly mode: 'ndjson' | 'binary';
  /**
   * 런타임이 `events:"push"` 핸드셰이크 capability 를 수용했는지 — ready() 정착
   * 후 읽는다. true 면 0xfffd 푸시 프레임이 stdout 으로 흐르고 onPushEvent
   * 구독이 실제 이벤트를 받는다. false 면(구 런타임, 미수용, codecs 미제공으로
   * 핸드셰이크 미실행) 푸시가 절대 오지 않으므로 구독자는 폴링을 써야 한다.
   * node-events 의 2-모드 dispatch가 이 플래그를 능력 판별 근거로 읽는다 —
   * 존재만으로는 판별할 수 없다(메서드는 능력과 무관하게 항상 노출됨).
   */
  readonly pushCapable: boolean;
  /** 프로토콜 협상(바이너리 모드 핸드셰이크) 정착을 기다린다. */
  ready(): Promise<void>;
  /**
   * 진행 중 invocation 이 모두 정착할 때까지 기다린다(최대 5초 — 초과 시 로그 후
   * 그래도 해소). reload 직전 drain 계약(A1)의 transport 측 구현.
   *
   * 옵셔널 멤버: 필수로 정의하면 이 인터페이스를 구조적으로 구현하던 외부
   * 구현체가 drain 부재로 깨진다(breaking). 호출측은 `transport.drain?.(...)` 로
   * 우아하게 폴백한다.
   */
  drain?(timeoutMs?: number): Promise<void>;
  /**
   * 0xfffd 푸시 프레임을 구독한다 — `(event) => unsubscribe`. 런타임
   * (loop-stdio)이 `events:"push"` 핸드셰이크로 싱크를 설치한 경우에만 프레임이
   * 흐른다. 메서드 존재는 능력이 아니라 0xfffd 프레임 수신 "경로"의 노출일 뿐 —
   * 실제 능력은 `pushCapable` 로 판별한다(node-events 2-모드 dispatch 계약).
   *
   * 옵셔널 멤버(drain? 과 동일 사유): 이 인터페이스를 구조적으로 구현하던
   * 외부 구현체의 브레이킹을 피한다. 호출측은 `transport.onPushEvent?.(...)`
   * 로 우아하게 폴백한다.
   *
   * payload 는 문자열 JSON — 파싱 책임은 구독자에 있다(폴링 drain 과 동일
   * 셰이프 경계).
   */
  onPushEvent?(
    handler: (event: { name: string; payload: string; seq: number }) => void,
  ): () => void;
  /**
   * 0xfffc 채널 프레임을 구독한다 — `(frame) => unsubscribe`. `createChannel`
   * 이 발급 핸들과 콜백을 잇는 데 쓴다(0.7 채널 트랙). 메서드 존재는 채널
   * "경로"의 노출이고 실제 능력은 바이너리 모드 협상에 있다 — NDJSON 모드의
   * transport 도 메서드는 갖지만 채널 프레임은 절대 오지 않는다.
   *
   * 필수 멤버 — 이 인터페이스의 실현체(createNodeLoopTransport)가 항상
   * 노출하며, 채널 프레임 demux 분기는 응답/푸시와 같은 리더 안에 있다.
   * payload 는 문자열 JSON — 파싱 책임은 채널 콜백 소유자에게 있다.
   */
  onChannelFrame(handler: (frame: { handle: number; payload: string }) => void): () => void;
  /**
   * 0xfff9 **바이너리** 채널 프레임을 구독한다 — `createNodeBytesChannel` 이
   * 발급 핸들과 콜백을 잇는 데 쓴다. JSON 채널(0xfffc)과 같은 리더 안의 demux
   * 분기를 공유하지만 payload 는 원시 바이트(Uint8Array)다.
   *
   * 옵셔널 멤버(drain?/onPushEvent? 와 동일 사유): 이 인터페이스를 구조적으로
   * 구현하던 외부 구현체의 브레이킹을 피한다. 호출측은
   * `transport.onChannelBytesFrame?.(...)` 로 우아하게 폴백한다.
   */
  onChannelBytesFrame?(handler: (frame: NodeChannelBytesFrame) => void): () => void;
  /**
   * 런타임이 `__hello` 에 `channelBytes: true` capability 를 에코했는지 —
   * ready() 정착 후 읽는다. 바이너리 채널(0xfffb 모드 `0x01` 발급 → 0xfff9
   * 프레임)은 런타임 bin 의 지원이 필요하다. false 면(구 런타임 — 모드 바이트를
   * 무시하고 JSON 채널을 파는 위상) `createNodeBytesChannel` 이
   * `channel.unavailable` 로 loud-fail 한다 — 조용한 경로 불일치 방지.
   *
   * 옵셔널 멤버(onChannelBytesFrame? 과 동일 사유). 구 런타임/구 실현체는
   * 이 필드가 undefined 이고, 호출측은 `!== true` 를 능력 부재로 읽는다.
   */
  readonly channelBytesCapable?: boolean;
};
