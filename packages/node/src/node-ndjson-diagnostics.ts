/**
 * NDJSON 실패 라인 진단 — 레거시 라인 프로토콜(node-loop.ts NDJSON 모드)의
 * 파싱 실패 라인 보존과 exit 컨텍스트 조립. 순수 함수·상수만 갖고 상태는
 * 호출측(transport 인스턴스 클로저)이 소유한다 — 라이프사이클은 transport
 * 생성/재스폰을 따르고, 스폰 없이 단위 검증한다(node-loop.test.ts).
 */
import { debugRustra, isRustraDebugEnabled, type RustraDebugEvent } from '@rustra/types';

/** 비 NDJSON 라인 링 버퍼 크기 — exit 시 대기 요청 에러에 첨부할 최근 줄 수. */
export const UNPARSED_LINES_CAPACITY = 32;

/**
 * 라인 1줄의 보존 상한(문자) — 멀티 MB 비 JSON 라인도 버퍼와 exit 메시지에
 * 온전히 살지 않도록 절단한다(stderr 꼬리 상한과 대칭). 보장은
 * `UNPARSED_LINES_CAPACITY` 줄 × 이 상한으로 이중 경계다.
 */
export const UNPARSED_LINE_MAX_CHARS = 4_096;

/** debug 모드에서 보존할 stderr 꼬리 상한(문자) — 무한 stderr 도 메모리 상한 유지. */
export const STDERR_TAIL_CHARS = 8_192;

/** transport 인스턴스별 unparsed 라인 진단 상태 — 링 버퍼와 1회 warn 플래그. */
export type UnparsedLineState = { buffer: string[]; warned: boolean };

/**
 * NDJSON 파싱 실패 라인 1점의 처리 — 진단 관측 지점을 순수 함수로 추출해 스폰
 * 없이 단위 검증한다(node-loop.test.ts, demultiplexBinaryFrame 추출과 동일 취지).
 * 상태는 호출측(transport 인스턴스 클로저)이 소유하고 이 함수가 in-place 로
 * 갱신한다 — 라이프사이클은 transport 생성/재스폰을 따른다.
 *
 * - debug 모드(`RUSTRA_DEBUG`)면 `kind: 'ndjson.unparsed'` debug 이벤트를 싱크로
 *   내고 stderr 에 **최초 1회만** warn 한다(로그 스팸 방지 — 워닝 규약은
 *   node-events 의 `parsePushPayload` 와 동일 톤).
 * - 비 debug 모드면 최근 `UNPARSED_LINES_CAPACITY` 줄을 ring 으로 보존한다(각
 *   줄은 `UNPARSED_LINE_MAX_CHARS` 로 절단) — 프로세스가 exit 할 때 대기 중
 *   요청의 에러 메시지에 첨부해, 사용자가 맨몸의 "exited" 오류 대신 자식이
 *   실제로 출력한 것을 보게 한다. 보존량은 줄 수와 줄 길이 이중으로 경계된다.
 */
export function recordUnparsedLine(line: string, state: UnparsedLineState): void {
  if (isRustraDebugEnabled()) {
    // debugRustra 는 이벤트 백을 pass-through(spread) 하므로 계약 밖 필드도 싱크에
    // 도달한다 — kind/line 을 읽기 편한 진단 어휘로 그대로 실어 보낸다.
    debugRustra({ kind: 'ndjson.unparsed', line } as unknown as RustraDebugEvent);
    if (!state.warned) {
      state.warned = true;
      console.warn(
        'Rustra: runtime stdout line was not valid NDJSON; continuing (first occurrence only).',
      );
    }
    return;
  }
  state.buffer.push(line.slice(0, UNPARSED_LINE_MAX_CHARS));
  if (state.buffer.length > UNPARSED_LINES_CAPACITY) {
    state.buffer.splice(0, state.buffer.length - UNPARSED_LINES_CAPACITY);
  }
}

/**
 * exit 시 대기 요청의 에러 메시지 조립 — 원문 계약 메시지를 접두로 유지하고
 * 보존된 unparsed 줄(및 debug 모드의 stderr 꼬리)이 있으면 덧붙인다. 기존
 * "exited before responding" 메시지를 단정하는 테스트·호출측이 있으므로 접두
 * 보존이 계약이다. 첨부가 비면 원문 그대로(기존 동작과 비트 동일).
 */
export function attachExitContext(
  message: string,
  unparsed: readonly string[],
  stderrTail?: string,
): string {
  const parts: string[] = [];
  if (unparsed.length > 0) {
    parts.push(`recent unparsed stdout lines:\n${unparsed.map((line) => `  ${line}`).join('\n')}`);
  }
  if (stderrTail) {
    parts.push(`stderr:\n${stderrTail}`);
  }
  return parts.length === 0 ? message : `${message}\n${parts.join('\n')}`;
}
