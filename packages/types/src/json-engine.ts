import { normalizeRustraError } from './errors.js';
import { debugRustra, isRustraDebugEnabled } from './debug.js';
import { invokeWithTimeout } from './cancel.js';
import type { BatchEntry, EngineClient, EngineClientWithBatch, InvokeOptions } from './public.js';

/**
 * json-engine 이 이미 아는 와이어 배치 표면 — transport 가 단일 IPC 횡단으로
 * N 개 명령을 실행할 수 있으면 제공한다(트랙 E2). 미제공 시 기존 Promise.all
 * 항목별 폴백으로 동작한다(기존 계약 불변).
 */
export type JsonWireBatchTransport = {
  invoke(command: string, args?: unknown): Promise<unknown> | unknown;
  /** 와이어 배치 — `rustra_dispatch_batch` 커맨드 한 번으로 N 개 명령 실행. */
  invokeBatch?(requests: BatchEntry[]): Promise<unknown[]> | unknown[];
};

/**
 * 응답 셰이프 이탈 보고 — debug 모드에서만 버전 스크의 조기 신호를 싱크로 보낸다
 * (`kind: 'response.shape'`, 규칙 식별은 `reason`). json-engine 은 스키마가 없어
 * `undefined`/원시형 응답은 판정할 수 없고(void 커맨드가 존재), reject 경로의
 * `{ok:false,error}` 는 이미 `normalizeRustraError` 가 정규화한다. 따라서
 * **resolve 경로에서 관찰되는 엔벨로프 왜곡**만 보수적으로 검사한다:
 *
 * - `double_envelope`: `{ok:true, result}` 엔벨로프가 원시 결과에 또 보이면
 *   와이어 디코드가 벗긴 뒤 한 겹 더 감싸진 이중 래핑 스크 신호.
 * - `failed_without_error`: `{ok:false}`인데 `error` 가 없으면 정규화 대상이
 *   없어 조용히 resolve — 실패가 값으로 변질된 스크 신호.
 * - `envelope_missing_payload`: `ok:true` 인데 `result`/`error` 키가 모두 없으면
 *   깨진 엔벨로프(페이로드 유실 — `ok:false` 의 동일 형태는 `failed_without_error`).
 * - `resolved_error_envelope`: `{ok:false, error}` 실패 엔벨로프가 reject 대신
 *   resolve 로 도달 — transport 가 정규화 없이 통과시킨 스크 신호.
 *
 * `{ok:true, error}` 하이브리드는 도메인 구조체일 수 있어 의도적으로 침묵한다.
 *
 * 경고가 아니라 debug 이벤트 발행이다 — 결과를 변형하지 않고 절대 던지지 않는다.
 * 위음성은 허용한다. `ok` 가 불리언인 객체만 검사하므로 가장 그럴듯한 위양성은
 * `ok`/`result` 필드 쌍을 가진 도메인 구조체가 `double_envelope` 로 오경보하는
 * 것 — debug 전용 경고(throw/변형 없음)로 감수한다. 프로퍼티 접근과 이벤트
 * 발행 전체를 try 로 감싼다.
 */
function reportResponseShape(command: string, result: unknown): void {
  if (!isRustraDebugEnabled()) return;
  try {
    if (typeof result !== 'object' || result === null) return;
    const ok = (result as { ok?: unknown }).ok;
    if (typeof ok !== 'boolean') return;
    const envelope = result as Record<string, unknown>;
    const hasResult = Object.prototype.hasOwnProperty.call(envelope, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(envelope, 'error');
    let reason: string | undefined;
    if (ok) {
      if (hasResult) reason = 'double_envelope';
      else if (!hasError) reason = 'envelope_missing_payload';
    } else if (!hasError) {
      reason = 'failed_without_error';
    } else {
      reason = 'resolved_error_envelope';
    }
    if (reason === undefined) return;
    debugRustra({
      direction: 'response',
      transport: 'json',
      command,
      kind: 'response.shape',
      reason,
      value: result,
    });
  } catch {
    // 감지 자체는 절대 invoke 를 실패로 만들지 않는다(프록시 등 특이 객체 방어).
  }
}

export function createJsonEngine(
  transport:
    ((command: string, args?: unknown) => Promise<unknown> | unknown) | JsonWireBatchTransport,
  normalizeArgs: (args?: unknown) => unknown = (args) => args,
): EngineClientWithBatch {
  const rawTransport: JsonWireBatchTransport =
    typeof transport === 'function' ? { invoke: transport } : transport;
  const rawEngine: EngineClient = {
    invoke<T>(command: string, args?: unknown): Promise<T> {
      try {
        const normalizedArgs = normalizeArgs(args);
        debugRustra({ direction: 'request', transport: 'json', command, value: normalizedArgs });
        return Promise.resolve(rawTransport.invoke(command, normalizedArgs))
          .then((result) => {
            debugRustra({ direction: 'response', transport: 'json', command, value: result });
            reportResponseShape(command, result);
            return result as T;
          })
          .catch((error: unknown) => {
            debugRustra({ direction: 'error', transport: 'json', command, error: String(error) });
            throw normalizeRustraError(error);
          }) as Promise<T>;
      } catch (error: unknown) {
        debugRustra({ direction: 'error', transport: 'json', command, error: String(error) });
        return Promise.reject(normalizeRustraError(error));
      }
    },
  };
  return {
    invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
      return invokeWithTimeout(rawEngine, command, args, options);
    },
    invokeBatch<T>(entries: BatchEntry[]): Promise<T[]> {
      // 와이어 배치(단일 횡단) 경로 — transport 가 지원할 때만. 항목별
      // options(signal/timeoutMs)가 섞이면 항목별 정책을 존중해 폴백한다.
      // 단일 횡단 경로는 항목별 debug/셰이프 감지를 거치지 않는다 — 진단이
      // 필요한 항목은 폴백 경로(options 를 통한 항목별 invoke)를 태운다.
      if (
        typeof rawTransport.invokeBatch === 'function' &&
        !entries.some((entry) => entry.options?.signal || entry.options?.timeoutMs)
      ) {
        return Promise.resolve(rawTransport.invokeBatch(entries)) as Promise<T[]>;
      }
      return Promise.all(
        entries.map((entry) =>
          invokeWithTimeout<T>(rawEngine, entry.command, entry.args, entry.options),
        ),
      );
    },
  };
}
