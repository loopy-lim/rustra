import { isRetryableCode, RustraCommandError, RustraErrorCode } from './errors.js';
import { decodeUtf8 } from './utf8.js';
import type { FrameCodec } from './public.js';

/**
 * 코덱 에러 메시지에서 실패 지점 오프셋을 회수하는 휴리스틱 — 생성 코덱
 * (postcard) 의 plain `Error` 는 위치를 싣지 않지만, `at byte 42` / `offset 7`
 * 형태로 위치를 싣는 코덱의 단서는 버리지 않는다(`offsets 3` 처럼 복수형이나
 * `3 bytes` 처럼 뒤따르는 수치에는 반응하지 않는다).
 */
const DECODE_OFFSET_HINT = /\b(?:offset|position|byte)\s*[:=]?\s*(\d+)/i;

/**
 * tier 2(JS 코덱) 응답 프레임을 결과/에러로 환산한다 — `dispatch` 와 전파
 * 경로 콜백이 공유하는 유일 경로 (T1 리뷰). `codec.decode` 가 잘못된 프레임으로
 * throw 하면(M3) `invoke.malformed` `RustraCommandError` 로 정규화해 reject
 * 값으로 돌린다 — 메시지에 명령명·실패 오프셋·프레임 길이와 `RUSTRA_DEBUG=1`
 * 힌트를 싣고, 원본 예외는 `cause` 로, 응답 프레임은 `frameBytes` 로 보존한다.
 * 예외가 이미 `RustraCommandError` 면 이중 래핑 대신 그대로 통과시키고, 정상
 * 경로(구조화된 `{ok:false, error:{code,message}}` 응답)의 code/retryable
 * 환산은 기존 계약 그대로다. 전파 경로의 콜백은 네이티브 트램펄린 안에서
 * 실행되므로 예외가 새어나가면 프라미스가 영원히 정착하지 않는다. 이 함수
 * 자체는 throw 하지 않는다.
 */
export function tier2Outcome<T>(
  codec: FrameCodec<unknown, unknown>,
  frame: ArrayBuffer | ArrayBufferView,
  command: string,
): { ok: true; value: T } | { ok: false; error: Error } {
  let response: ReturnType<FrameCodec<unknown, unknown>['decode']>;
  try {
    response = codec.decode(frame);
  } catch (err) {
    // 이미 구조화된 에러(코덱이 직접 던진 RustraCommandError 계열)는 코드를
    // 보존한다 — invoke.malformed 로 덮어쓰면 기존 error.code 분기가 깨진다.
    if (err instanceof RustraCommandError) return { ok: false, error: err };
    const byteLength = frame.byteLength;
    const detail = err instanceof Error ? err.message : String(err);
    const hint = DECODE_OFFSET_HINT.exec(detail);
    // 코덱 에러가 위치를 알려주지 않으면 프레임 끝(전체 길이)이 실패 지점의
    // 최선 추정이다 — 'varint out of bounds' 류는 디코더가 버퍼 끝을 넘어
    // 읽으려다 실패한 것이므로.
    const offset = hint ? Number(hint[1]) : byteLength;
    const error = new RustraCommandError(
      RustraErrorCode.InvokeMalformed,
      `decode failed for '${command}' at offset ${offset}: ${detail} (${byteLength}-byte frame)` +
        ` — set RUSTRA_DEBUG=1 to dump wire bytes`,
      false,
      err,
    );
    // 코덱의 스택(어느 디코드 단계에서 터졌는지)이 정규화 에러의 스택보다
    // 진단 가치가 크다 — normalizeRustraError 와 같은 관례로 보존한다.
    if (err instanceof Error && err.stack) error.stack = err.stack;
    // (M8) 실패 프레임 원본을 에러에 실어 devtools 포렌식이 hex 절단을 남길
    // 수 있게 한다. slice() 로 독립 복사본을 만든다 — 네이티브가 응답 버퍼를
    // 재사용하더라도 로그가 변조되지 않는다.
    const view =
      frame instanceof ArrayBuffer
        ? new Uint8Array(frame)
        : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
    error.frameBytes = view.slice();
    return { ok: false, error };
  }
  if (!response.ok) {
    const e = response.error ?? { code: 'invoke.failed', message: 'Frame invoke failed' };
    return {
      ok: false,
      error: new RustraCommandError(e.code, e.message, e.retryable ?? isRetryableCode(e.code)),
    };
  }
  return { ok: true, value: response.result as T };
}

/**
 * (T3) 인코딩된 페이로드의 크기 사전 검사 — JS 코덱(tier 2)/tier 3 경로가
 * 네이티브를 호출하기 직전에 공유한다. `limit` 이 undefined 면 검사하지 않는다
 * (네이티브의 동적 한도가 최종 게이트). 초과 시 `payload.too_large`
 * (non-retryable — 결정론적 클라이언트 조건) 를 반환하고 호출자는 네이티브
 * 왕복 없이 즉시 reject 한다.
 */
export function payloadTooLargeError(
  encodedBytes: number,
  limit: number | undefined,
): RustraCommandError | undefined {
  if (limit === undefined || encodedBytes <= limit) return undefined;
  return new RustraCommandError(
    'payload.too_large',
    `encoded payload ${encodedBytes}B exceeds maxPayloadBytes ${limit}B`,
    false,
  );
}

import type { FrameSchemaNative } from './live-schema.js';
import type { FrameSchemaRuntime } from './frame-engine-context.js';
import type { FrameEngineOptions } from './frame-engine-options.js';

export function validateFrameEngineOptions(
  native: FrameSchemaNative,
  options: FrameEngineOptions | undefined,
  schema: FrameSchemaRuntime,
): void {
  // F5 (opt-in) + A2 (정책): 계약 해시 검증. 빌드 시점 hash 와 네이티브 실시간
  // hash 가 다르면 기본적으로 엔진을 만들지 않고 즉시 실패(fail-fast)한다. T2
  // onContractMismatch 콜백을 설정하면 불일치 시 throw 대신 콜백 호출 후
  // degraded 모드로 계속 생성한다. A2 contractVerification 은 이 실패 처리의
  // 정책 노브다 — 'warn' 은 throw 를 경고로 강등해 엔진 생성을 항상 보장하고
  // (OTA/degraded 배포), 'off' 는 contractHash 설정 여부와 무관하게 검증 자체를
  // 생략한다(생성 엔트리의 탈출구). 미설정은 'strict' 와 동일 — 기존 동작
  // 그대로다(하위 호환).
  const verification = options?.contractVerification;
  if (options?.contractHash !== undefined && verification !== 'off') {
    if (typeof native.getContractHash !== 'function') {
      if (verification === 'warn') {
        // 'warn' 은 unenforceable 도 치명적이지 않게 강등한다 — 검증 불가
        // 상태에서도 앱은 동작해야 한다는 것이 이 정책의 요점이다(schemaVersion
        // stale 경고와 같은 non-fatal 계약). 콜백은 여기서 만지지 않는다 —
        // native hash 를 읽을 방법이 없어 콜백 info 를 채울 수 없기 때문이다.
        console.warn(
          '[rustra] contract verification skipped: contractHash option was set but the native ' +
            'module does not expose getContractHash(); cannot verify schema drift ' +
            "(contractVerification: 'warn' — continuing without verification). Check that the " +
            'current generated codecs and Rust native archive were both compiled into the ' +
            'installed app.',
        );
      } else {
        // strict(기본)은 콜백과 무관하게 항상 throw — native hash 가 없으면
        // degraded 모드가 무의미하다 (검증 가능한 것이 아무것도 없다).
        throw new RustraCommandError(
          'contract.unenforceable',
          'contractHash option was set but the native module does not expose ' +
            'getContractHash(); cannot verify schema drift. Check that the current generated codecs ' +
            'and Rust native archive were both compiled into the installed app.',
        );
      }
    } else {
      const hashBytes = new Uint8Array(native.getContractHash());
      const nativeHash = decodeUtf8(hashBytes, 0, hashBytes.length).trim();
      if (nativeHash !== options.contractHash) {
        if (options.onContractMismatch) {
          // 콜백 우선순위는 정책과 무관하다 — 기본(strict)과 'warn' 모두
          // 콜백이 있으면 console.warn 폴백 대신 콜백을 탄다.
          options.onContractMismatch({ nativeHash, expectedHash: options.contractHash });
        } else if (verification === 'warn') {
          console.warn(
            `[rustra] contract hash mismatch: native="${nativeHash.slice(0, 16)}…" vs ` +
              `expected="${options.contractHash.slice(0, 16)}…" — generated client ` +
              `and native binary are out of sync; regenerate the TypeScript and native codecs, ` +
              `rebuild the Rust archive, then rebuild the native app ` +
              `(contractVerification: 'warn' — continuing with a degraded engine)`,
          );
        } else {
          throw new RustraCommandError(
            'contract.mismatch',
            `contract hash mismatch: native="${nativeHash.slice(0, 16)}…" vs ` +
              `expected="${options.contractHash.slice(0, 16)}…" — generated client ` +
              `and native binary are out of sync; regenerate the TypeScript and native codecs, ` +
              `rebuild the Rust archive, then rebuild the native app`,
          );
        }
      }
    }
  }

  // T2 (opt-in): schemaVersion staleness 검사. JS > native 면 경고만 한다
  // (fatal 아님 — OTA 롤백/지연 배포 상황에서도 앱은 동작해야 한다).
  // getSchema 미노출 구 네이티브는 조용히 건너뛴다 (비교할 것이 없다).
  if (options?.schemaVersion !== undefined && typeof native.getSchema === 'function') {
    // 구 네이티브(pre-Task-8)의 schema JSON 에는 schemaVersion 이 없다 —
    // CLI old-schema 관례대로 1 로 취급한다. 이 기능의 대상이 되는 정확히 그
    // 구 바이너리를 향한 스퓨리어스 경고를 막는 디폴트다.
    //
    // 스키마 파싱(getSchema 호출 자체의 실패 포함)은 절대 치명적이지 않다 —
    // 파싱이 throw 하면 staleness 검사를 조용히 건너뛴다 (getSchema 미노출
    // 경우와 동일한 취급). 경고 기능이 엔진 생성을 깨뜨리면 "fatal 아님"
    // 계약 자체가 위반된다. invoke 시점의 tier-3 스키마 파싱(getLiveSchema)은
    // 별개의 기존 동작 — malformed 스키마에서 동적 명령 호출 시 JSON.parse 가
    // dispatch 밖으로 동기 throw 할 수 있다.
    let nativeVersion: number | undefined;
    try {
      const document = schema.readLiveSchemaDocument();
      nativeVersion = document.schemaVersion ?? 1;
    } catch {
      nativeVersion = undefined;
    }
    if (nativeVersion !== undefined && options.schemaVersion > nativeVersion) {
      const info = { nativeVersion, jsVersion: options.schemaVersion };
      if (options.onSchemaStale) {
        options.onSchemaStale(info);
      } else {
        console.warn(
          `[rustra] schema stale: JS bundle schemaVersion=${info.jsVersion} > ` +
            `native schemaVersion=${info.nativeVersion} — native binary is older ` +
            `than the JS bundle (OTA rollback / delayed rollout); newer commands ` +
            `may fail until native catches up`,
        );
      }
    }
  }
}
