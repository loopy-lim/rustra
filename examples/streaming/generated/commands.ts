// ── rustra generated ────────────────────────────────────────
// File:   commands.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import type { JobStatusInput, JobStatusOutput, StartJobInput, StartJobOutput } from './types.js';
import { createGeneratedFields1, invokeGenerated, invokeGeneratedFields3 } from '@rustra/types';
import type { InvokeOptions as CoreInvokeOptions } from '@rustra/types';

/**
 * 이 패키지 생성 명령의 호출 옵션 — 모든 생성 함수의 마지막 파라미터.
 *
 * ⚠️ **얕은 취소**: `signal` 이 실행 중에 abort 되면 **JS 프라미스만 거부되고**
 * (shallow cancellation) Rust 명령은 끝까지 실행되거나 이미 완료됐을 수 있습니다.
 * 취소/타임아웃은 "명령이 실행되지 않았음"을 보장하지 않습니다.
 *
 * ⚠️ **`retryable: true` ≠ 재실행 안전**: `transport.timeout`·`cancelled` 등
 * retryable 오류는 재시도 시 실패 유형이 사라질 수 있음을 뜻할 뿐, 명령을 다시
 * 실행해도 안전하다는 뜻이 아닙니다. 비멱등 명령의 재시도는 상태를 재조회해 이전
 * 시도가 반영되지 않았음을 확인한 뒤에만 하세요.
 *
 * 전체 의미론은 docs/compatibility-matrix.md "Signal semantics in detail" 및
 * 원본 타입(`InvokeOptions`(@rustra/types)) 문서를 참고하세요.
 */
export type InvokeOptions = CoreInvokeOptions;

/**
 * 현재 진행 중인 작업 상태 조회 — 폴링 기반 UI 폴백용.
 */
export const jobStatus = createGeneratedFields1<JobStatusInput, JobStatusOutput>(2, 'jobStatus', "jobId", 'jobStatus');

export function startJob(input: StartJobInput, options?: InvokeOptions): Promise<StartJobOutput> {
  return invokeGeneratedFields3<StartJobOutput>(1, 'startJob', input, input["jobId"], input["totalSteps"], input["stepDelayMs"], options);
}
startJob.commandId = 'startJob';
