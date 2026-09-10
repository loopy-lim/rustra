/**
 * @rustra/node 채널 — loop-stdio 바이너리 모드의 역방향 스트림. RN/Tauri
 * `createChannel` 과 동형 계약 `{ handle, close() }` 이다.
 *
 * ### 와이어 (loop-stdio 0.7 채널 예약 cmd id)
 *
 * 발급/해제는 이벤트 drain(0xfffe)과 같은 예약 커맨드 프레임으로 간다:
 *
 * ```text
 * 발급  [len u32 LE][0xfffb u16 LE]                  → [ok][len][{"handle":u32}]
 * 해제  [len u32 LE][0xfffa u16 LE][varint u32 핸들]  → [ok=살아있었으면 1][pad]
 * 프레임 [len u32 LE][0xfffc u16 LE][1줄 JSON {"handle","payload"}]
 * ```
 *
 * Rust 쪽 발급 sender 는 STDOUT_LOCK 임계구역에서 0xfffc 프레임을 쓴다 —
 * 비동기 핸들러의 백그라운드 스레드 send 가 응답/푸시 쓰기와 경합해도 프레임이
 * 찢어지지 않는다(이벤트 푸시 싱크와 동일 규약). 즉 **Bun FFI 브릿지의
 * threadsafe:false 스레드 계약과 달리, 백그라운드 스레드 send 도 안전하다** —
 * 채널 프레임은 JS 턴을 거치는 stdout 데이터 이벤트로 도달하기 때문이다.
 *
 * ### 바이너리 채널 (createNodeBytesChannel)
 *
 * 바이트 경로는 같은 예약 프레임의 확장이다 — 발급(0xfffb) 본문에 모드 플래그
 * `0x01` 을 붙이고 푸시 프레임은 0xfff9 을 쓴다:
 *
 * ```text
 * 발급      [len u32 LE][0xfffb u16 LE][mode u8 = 0x01]  → [ok][len][{"handle":u32}]
 * 바이트 프레임 [len u32 LE][0xfff9 u16 LE][handle u32 LE][payload bytes]
 * ```
 *
 * 페이로드는 rkyv V2 프레임 등 임의 바이트를 JSON 래핑 없이 그대로 실으며
 * 길이 접두가 없다(프레임 래퍼의 len 이 경계를 제공). 해제(0xfffa)는 두 경로를
 * 같이 내리는 코어 `drop_channel` 을 공유한다. 한 핸들은 한 경로로만 동작한다
 * (JSON xor bytes — 코어 ChannelHost 계약). 바이너리 모드 협상에 더해 런타임이
 * `__hello` 에 `channelBytes: true` capability 를 에코해야 한다 — 모드 바이트를
 * 무시하고 JSON 채널을 파는 구 런타임에서 조용히 프레임이 죽는 대신
 * `channel.unavailable` 로 loud-fail 한다(RN `createBytesChannel` 계약과 동일
 * 철학).
 *
 * ### 바이너리 모드 전용
 *
 * 채널은 콜백 등록이 전제인데 NDJSON 라인 프로토콜엔 프레임 경로가 없다 —
 * transport 가 codecs 와 함께 생성돼 바이너리 모드로 협상됐을 때만 동작한다.
 * NDJSON transport 에선 첫 createChannel 이 loud-fail 한다(조용한 빈 스트림
 * 방지 — node-events 능력 부재 계약과 동일 철학). 정착 전에는
 * `transport.ready()` 를 기다렸다가 능력을 판정한다.
 *
 * ### 발급-실패 정리 (Tauri 어댑터와 동일)
 *
 * 발급(0xfffb)이 먼저고, 채널 프레임 구독(`transport.onChannelFrame`)이 실패하면
 * 발급된 핸들을 0xfffa drop 으로 정리한다 — 리스너 없는 채널은 프레임을 받을 수
 * 없으므로 누수다. close 는 구독 해지 + drop invoke, late frame 은 무시,
 * double-close 는 idempotent(false).
 */
import { RustraCommandError, RustraErrorCode } from '@rustra/types';
import type { NodeEventTransport } from './node-events.js';

export type NodeChannelCallback = (payload: unknown) => void;

export type NodeChannel = {
  /** 커맨드 인자로 통과시키는 채널 핸들(wire 는 plain u32). */
  readonly handle: number;
  /** 채널을 해제한다 — 0xfffa drop + 프레임 구독 해지. 이후 프레임은 무시. */
  close(): Promise<boolean>;
};

/** 바이너리 채널 콜백 — 페이로드는 JSON 파싱 없는 원시 바이트(rkyv V2 프레임 등). */
export type NodeBytesChannelCallback = (payload: Uint8Array) => void;

/** 바이너리 채널 — JSON 채널(NodeChannel)과 동일 { handle, close() } 계약. */
export type NodeBytesChannel = {
  /** 커맨드 인자로 통과시키는 채널 핸들(wire 는 plain u32, JSON 경로와 공간 공유). */
  readonly handle: number;
  /** 채널을 해제한다 — 0xfffa drop(두 테이블을 같이 내림) + 구독 해지. */
  close(): Promise<boolean>;
};

/** 채널 프레임 경로가 있는 transport — 실 NodeLoopTransport 가 노출한다. */
type ChannelCapableTransport = NodeEventTransport & {
  onChannelFrame(handler: (frame: { handle: number; payload: string }) => void): () => void;
  ready?(): Promise<void>;
  readonly mode?: 'ndjson' | 'binary';
};

/** 바이너리 채널 프레임 경로가 있는 transport — 실 NodeLoopTransport 가 노출한다. */
type BytesChannelCapableTransport = NodeEventTransport & {
  onChannelBytesFrame?(
    handler: (frame: { handle: number; payload: Uint8Array }) => void,
  ): () => void;
  ready?(): Promise<void>;
  readonly mode?: 'ndjson' | 'binary';
  readonly channelBytesCapable?: boolean;
};

async function ensureBinaryMode(
  transport: Pick<ChannelCapableTransport, 'ready' | 'mode'>,
  ndjsonMessage: string,
): Promise<void> {
  // 능력 확정 대기 — 바이너리 협상은 transport 생성 시 kick 되지만 정착은
  // 비동기다. NDJSON 확정(구 런타임/codecs 미제공)이면 여기서 loud-fail 한다.
  if (transport.ready) await transport.ready();
  if (transport.mode === 'ndjson') {
    throw new RustraCommandError(RustraErrorCode.ChannelUnavailable, ndjsonMessage);
  }
}

async function issueNodeChannelHandle(
  transport: Pick<ChannelCapableTransport, 'invoke'>,
  createCommand: string,
  invalidHandleMessage: string,
): Promise<number> {
  const issued = (await transport.invoke(createCommand)) as { handle?: unknown };
  const handle = issued?.handle as number;
  if (!Number.isSafeInteger(handle) || (handle as number) < 1) {
    throw new RustraCommandError(RustraErrorCode.ChannelUnavailable, invalidHandleMessage);
  }
  return handle;
}

function channelCloser(
  transport: Pick<ChannelCapableTransport, 'invoke'>,
  state: { closed: boolean },
  detach: () => void,
  handle: number,
): () => Promise<boolean> {
  return async (): Promise<boolean> => {
    if (state.closed) return false;
    state.closed = true;
    detach();
    // 0xfffa drop 은 JSON/바이트 두 테이블을 같이 내린다(코어 drop_channel).
    const dropped = (await transport.invoke('__dropChannel', { handle })) as unknown;
    return dropped === true;
  };
}

/**
 * loop-stdio transport 의 채널을 발급한다 — Rust `ChannelHandle::send` 가
 * 0xfffc 프레임으로 흘려보내는 역방향 스트림을 콜백으로 변환한다.
 * RN/Tauri `createChannel` 과 동형 계약.
 *
 * @param transport — 바이너리 모드로 협상된 loop-stdio transport. NDJSON 모드는
 *   loud-fail 한다(채널은 바이너리 전용 — 위 모듈 JSDoc).
 *
 * @example
 * ```ts
 * const transport = createNodeLoopTransport({ command: bin, codecs: rkyvV2Registry });
 * const channel = await createNodeChannel(transport, (payload) => console.log(payload));
 * await channelDemo(engine, { channel: channel.handle, ticks: 3 });
 * await channel.close();
 * ```
 */
export async function createNodeChannel(
  transport: ChannelCapableTransport,
  callback: NodeChannelCallback,
): Promise<NodeChannel> {
  if (typeof transport.onChannelFrame !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.ChannelUnavailable,
      'This transport cannot deliver channel frames: it does not expose onChannelFrame. Attach channels to a createNodeLoopTransport({ command, codecs }) runtime (loop-stdio binary mode) instead of a one-shot invoke binary.',
    );
  }
  await ensureBinaryMode(
    transport,
    'transport stayed on legacy NDJSON (no binary capability) — channels require binary mode; create the transport with codecs',
  );

  // 발급이 먼저다 — 구독 부재는 배선 에러고 발급 실패는 핸들 공간 에러다.
  // 발급 성공 후 구독 경로 자체는 동기 등록이라 실패하지 않지만, 등록 직후
  // closed 플래그로 late frame 을 무시한다(Tauri 어댑터와 동일 위상).
  const state = { closed: false };
  const handle = await issueNodeChannelHandle(
    transport,
    '__createChannel',
    'loop-stdio returned an invalid channel handle; expected a positive safe integer',
  );
  const detach = transport.onChannelFrame((frame) => {
    if (state.closed || frame.handle !== handle) return;
    // Rust sender 가 문자열 JSON을 실어 보낸다 — 파싱 1회 복원. 실패 시 원본
    // 문자열 전달(조용한 드롭 방지 — Tauri/Bun 어댑터 동일 관용).
    let payload: unknown;
    try {
      payload = frame.payload === '' ? null : JSON.parse(frame.payload);
    } catch {
      payload = frame.payload;
    }
    try {
      callback(payload);
    } catch (error) {
      // 콜백 예외 격리 — 전달 경로(stdout 리더)가 죽지 않는다(RN/Node 동일 정책).
      console.error('Rustra: channel callback threw:', error);
    }
  });

  return {
    handle,
    close: channelCloser(transport, state, detach, handle),
  };
}

/**
 * loop-stdio transport 의 **바이너리** 채널을 발급한다 — Rust
 * `ChannelHandle::send_bytes` 가 0xfff9 프레임으로 흘려보내는 역방향 바이트
 * 스트림을 콜백으로 변환한다. RN `createBytesChannel` / JSON 경로
 * `createNodeChannel` 과 동형 계약(콜백이 Uint8Array 를 받는 점만 다르다).
 *
 * 능력 판정은 3단계다 — 순서대로 (1) 프레임 경로 부재(원샷 transport),
 * (2) NDJSON 확정(구 런타임/codecs 미제공), (3) `channelBytes` capability
 * 부재(모드 바이트를 무시하는 구 런타임). 모두 `channel.unavailable`
 * loud-fail — 조용한 빈 스트림이나 경로 불일치(JSON 프레임 수신)를 내지
 * 않는다.
 *
 * @param transport — 바이너리 모드로 협상된 loop-stdio transport. NDJSON 모드와
 *   capability 미에코 런타임은 loud-fail 한다(위 모듈 JSDoc).
 * @param callback — 페이로드는 수신 버퍼의 복사본(사용자 코드가 버퍼를 붙잡아도
 *   transport 수신 경로와 무관하다).
 *
 * @example
 * ```ts
 * const transport = createNodeLoopTransport({ command: bin, codecs: rkyvV2Registry });
 * const channel = await createNodeBytesChannel(transport, (frame) => decode(frame));
 * await channelDemoBytes(engine, { channel: channel.handle, ticks: 3 });
 * await channel.close();
 * ```
 */
export async function createNodeBytesChannel(
  transport: BytesChannelCapableTransport,
  callback: NodeBytesChannelCallback,
): Promise<NodeBytesChannel> {
  if (typeof transport.onChannelBytesFrame !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.ChannelUnavailable,
      'This transport cannot deliver binary channel frames: it does not expose onChannelBytesFrame. Attach channels to a createNodeLoopTransport({ command, codecs }) runtime (loop-stdio binary mode) instead of a one-shot invoke binary.',
    );
  }
  await ensureBinaryMode(
    transport,
    'transport stayed on legacy NDJSON (no binary capability) — binary channels require binary mode; create the transport with codecs',
  );
  if (transport.channelBytesCapable !== true) {
    // 구 런타임: 0xfffb 모드 바이트를 무시하고 JSON 채널을 파버린다 — 프레임을
    // 보내기 전에 끊는다(0xfff9 구독은 영원히 비는 조용한 실패 방지).
    throw new RustraCommandError(
      RustraErrorCode.ChannelUnavailable,
      'runtime did not advertise binary channel support (no channelBytes capability in the __hello response) — upgrade the loop-stdio runtime to use binary channels',
    );
  }

  // 발급이 먼저다 — createNodeChannel 과 동일 위상(발급 실패 = 핸들 공간 에러).
  const state = { closed: false };
  const handle = await issueNodeChannelHandle(
    transport,
    '__createChannelBytes',
    'loop-stdio returned an invalid binary channel handle; expected a positive safe integer',
  );
  const detach = transport.onChannelBytesFrame((frame) => {
    if (state.closed || frame.handle !== handle) return;
    // 수신 누적 버퍼의 뷰를 복사해 내보낸다 — 사용자 코드가 프레임을 보관해도
    // transport 의 수신 버퍼 라이프사이클과 결합되지 않는다(버퍼 채택/concat
    // 최적화가 사용자 계약을 오염시키지 않는 경계).
    const payload = new Uint8Array(frame.payload);
    try {
      callback(payload);
    } catch (error) {
      // 콜백 예외 격리 — 전달 경로(stdout 리더)가 죽지 않는다(RN/Node 동일 정책).
      console.error('Rustra: bytes channel callback threw:', error);
    }
  });

  return {
    handle,
    close: channelCloser(transport, state, detach, handle),
  };
}
// ── 코드젠 계약 정합(컴파일 타임 고정) ──────────────────────
// 채널 콜백 시그니처와 { handle, close() } 반환 구조가 RN 계약과 동형임을
// 타입 레벨에서 고정한다(Tauri/Bun 채널 어댑터와 동일 패턴).

type GeneratedChannelHandle = number;
const _channelHandleFitsGenerated: GeneratedChannelHandle = ({} as NodeChannel).handle;
void _channelHandleFitsGenerated;
const _bytesChannelHandleFitsGenerated: GeneratedChannelHandle = ({} as NodeBytesChannel).handle;
void _bytesChannelHandleFitsGenerated;
