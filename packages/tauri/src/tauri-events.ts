import {
  debugRustra,
  RustraCommandError,
  RustraErrorCode,
  type RustraDebugEvent,
} from '@rustra/types';
import type { TauriListen } from './index.js';

type TauriGlobal = {
  __TAURI__?: { event?: { listen?: TauriListen } };
};

function tauriGlobal(): TauriGlobal {
  return globalThis as TauriGlobal;
}

// ── 이벤트 구독 (Rust → JS push) ──────────────────────────
// Rust 측 `tauri_support::register_with_events` 가 `Package::emit` 을
// `app.emit("rustra://{sanitized}", payload_json)` 로 전달한다 — 이 섹션은 그
// 채널을 JS 에서 구독하는 래퍼다. 과거엔 Rust 푸시만 있고 JS 구독 API 가 없어
// 사용자가 채널 규약을 문서에서 해석해 직접 listen 배선해야 했다.

function requireTauriListen(): TauriListen {
  const events = tauriGlobal().__TAURI__?.event;
  if (typeof events?.listen !== 'function') {
    throw new RustraCommandError(
      RustraErrorCode.TransportUnavailable,
      'Tauri event.listen was not found. Enable app.withGlobalTauri, or pass a listen function.',
    );
  }
  return events.listen.bind(events);
}

/**
 * rustra 이벤트명 → Tauri 채널명 (`rustra://{sanitized}`).
 *
 * Rust `tauri_support::sanitize_event_name` 과 **문자 단위까지 동일한** 규칙이다
 * (R02 — 양쪽이 다른 규칙을 쓰면 비 ASCII 이벤트가 조용히 유실됐다):
 *
 * 1. 코드포인트 순회(`for..of` — UTF-16 코드 유닛 순회가 아니라).
 * 2. `[A-Za-z0-9/_:-]` 와 Unicode 알파벳·숫자(`\p{Alphabetic}|\p{N}` — 한글,
 *    CJK, 비 BMP 영숫자 포함)는 그대로 보존한다. `\p{L}` 이 아니라
 *    `\p{Alphabetic}` 인 이유: Rust `char::is_alphanumeric()` 이
 *    Alphabetic ∪ N 이므로(예: U+0345) 양쪽 술어를 일치시킨다.
 * 3. 그 외 문자(구두점·기호·공백·NonAlphabetic 결합 문자)는 `_` 로 치환한다.
 * 4. NFC 정규화는 하지 않는다 — 정규화 후 같아지는 이름도 다른 이름이며, 그런
 *    충돌은 Rust 빌더가 `Package::build` 시점에 거부한다(단일 진실원 — 이벤트
 *    등록은 Rust 측에서만 일어난다).
 *
 * 코드포인트 1개당 결과도 최대 1개라 비 BMP 문자(이모지 등)가 surrogate 2개로
 * 갈라져 `_` 2개가 되는 구 규칙의 결함도 함께 사라진다.
 */
export function rustraEventChannel(name: string): string {
  const allowed = /[A-Za-z0-9/_:-]/;
  const unicodeAlnum = /\p{Alphabetic}|\p{N}/u;
  let sanitized = '';
  for (const c of name) {
    sanitized += allowed.test(c) || unicodeAlnum.test(c) ? c : '_';
  }
  return `rustra://${sanitized}`;
}

/**
 * 리스너 콜백 예외의 관측 지점(R01) — 예외는 재던지지 않고 삼킨다. Tauri 이벤트
 * 기계로 예외가 탈출하면 콜백 재호출/형제 리스너 중단이 관찰됐으므로, 브라우저
 * EventTarget 표준과 같은 정책(각 리스너 독립, 예외는 보고 후 계속)을 적용한다.
 * 진단은 `@rustra/types` 의 debug 스위치로 관측한다 — `configureDebug` 싱크에는
 * 항상 도달하고, `RUSTRA_DEBUG` 가 없으면 콘솔 출력은 없다.
 */
function reportListenerError(name: string, error: unknown): void {
  // debugRustra 는 이벤트 백을 pass-through(spread) 하므로 계약 밖 필드도 싱크에
  // 도달한다 — kind/command/error 를 읽기 편한 진단 어휘로 그대로 실어 보낸다.
  try {
    debugRustra({
      kind: 'tauri.listener_error',
      command: name,
      // 스택 보존 — Error 면 stack 이 우선, 그 외 throwable 은 String 이 안전하다.
      error: error instanceof Error ? (error.stack ?? String(error)) : String(error),
    } as unknown as RustraDebugEvent);
  } catch {
    // 진단 자체의 실패는 전달 경로로 탈출하지 않는다(json-engine 의 "감지 자체는
    // 절대 invoke 를 실패로 만들지 않는다"와 동일 계약).
  }
}

/** 콜백 호출의 유일한 경로(R01) — 모든 콜백 호출(파싱 성공/폴백 raw-string
 * 모두)이 이 경계를 지난다. 예외는 관측 후 삼켜 형제 리스너를 보호한다. */
function invokeListener<T>(name: string, callback: (payload: T) => void, payload: T): void {
  try {
    callback(payload);
  } catch (error) {
    reportListenerError(name, error);
  }
}

/**
 * rustra 이벤트를 구독한다 — 모든 어댑터와 같은 `(name, callback[, listen])`
 * 형태다. Rust `Package::emit`의 JSON 페이로드는 여기서 한 번 파싱한다.
 *
 * 오류 경계는 두 개로 분리된다(R01): (1) 전송 변환 — `JSON.parse` 실패 시 원본
 * 문자열을 그대로 한 번 전달한다(재호출이 아니라 유일한 단일 전달). (2) 사용자
 * 콜백 — 콜백 예외는 `reportListenerError` 로 관측만 하고 재던지지 않는다. 예외가
 * Tauri 이벤트 기계로 탈출하면 콜백이 이벤트 하나당 여러 번 불리거나 형제
 * 리스너가 깨지는 것이 관찰됐다(브라우저 EventTarget 도 리스너 예외를 삼킨다).
 *
 * @example
 * ```ts
 * const unsubscribe = await subscribeEvent('progress.tick', (payload) => console.log(payload));
 * // 정리 시: unsubscribe()
 * ```
 */
export async function subscribeEvent<T = unknown>(
  name: string,
  callback: (payload: T) => void,
  listen?: TauriListen,
): Promise<() => void> {
  const resolvedListen = listen ?? requireTauriListen();
  const unlisten = await resolvedListen(rustraEventChannel(name), (event) => {
    // 경계 1 — 전송 변환. payload 는 Rust 가 JSON 직렬화한 문자열이다.
    let payload: T;
    try {
      payload = JSON.parse(event.payload) as T;
    } catch {
      // 파싱 실패 시 원본 문자열이라도 전달한다(조용한 드롭 방지) — 콜백
      // 재호출이 아니라 유일한 단일 전달이다. 전달도 invokeListener 경계를
      // 지난다(R01 보강 — 폴백 경로의 무음 이스케이프 제거).
      invokeListener(name, callback, event.payload as unknown as T);
      return;
    }
    // 경계 2 — 사용자 콜백. 예외는 관측 후 삼켜 형제 리스너를 보호한다.
    invokeListener(name, callback, payload);
  });
  return unlisten;
}

/** Tauri global event API를 자동 감지하는 zero-config 구독 래퍼. */
export function subscribeTauriEvent<T = unknown>(
  name: string,
  callback: (payload: T) => void,
  listen: TauriListen = requireTauriListen(),
): Promise<() => void> {
  return subscribeEvent(name, callback, listen);
}

// ── 코드젠 SubscribeFn 정합 (컴파일 타임 고정) ─────────────────
// 코드젠(generateEventsTs)이 생성하는 `SubscribeFn` 계약:
//   <N extends RustraEventName>(name: N, cb: (payload: RustraEventPayloads[N]) => void)
//     => (() => void) | Promise<() => void>
// 4호스트 subscribeEvent 가 이 계약을 만족하는지 타입 레벨에서 고정한다.
// RustraEventName 은 스키마별 이름만 다르므로 이벤트 1개('x': number)를 가진
// 동형 계약으로 정합을 검증한다 — 계약 구조가 바뀌면 tsc 가 깨진다.

/** 생성 계약의 동형 타입 — 이벤트 'x' 하나가 선언된 스키마에 상당. */
type ContractPayloads = { x: number };
type ContractName = keyof ContractPayloads & string;
type GeneratedSubscribeFn = <N extends ContractName>(
  name: N,
  callback: (payload: ContractPayloads[N]) => void,
) => (() => void) | Promise<() => void>;

// 정합 1 — Tauri 본체가 생성 SubscribeFn 자리를 채운다(payload 타입 소거는
// SubscribeFn 의 callback 매개변수가 공변 위치라 안전).
const _tauriAsGenerated: GeneratedSubscribeFn = (name, callback) =>
  subscribeEvent(name, callback as (payload: unknown) => void) as unknown as
    (() => void) | Promise<() => void>;
void _tauriAsGenerated;
