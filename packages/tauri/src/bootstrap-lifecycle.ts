import { RustraCommandError, RustraErrorCode } from '@rustra/types';

/**
 * bootstrap 수명 상태(A05) — R08 loud-fail 가드 위의 로컬 상태 3종.
 * `draining` 은 drain 이 미연결(호스트가 직접 transport drain 을 호출)인 현재
 * 계약에서는 문서로만 존재한다(docs/compatibility-matrix.md A1 절 참고).
 */
export type BootstrapState = 'initializing' | 'ready' | 'disposed';

/** dispose 후 ready 재진입 loud-fail 계약의 공용 에러 — 어댑터별 메시지 접두 포함. */
export function disposedBootstrapError(adapter: string): RustraCommandError {
  return new RustraCommandError(
    RustraErrorCode.TransportUnavailable,
    `This ${adapter} bootstrap has been disposed. Create a new bootstrap to re-initialize ` +
      `the engine — ready() after dispose() is rejected instead of silently re-resolving.`,
  );
}
