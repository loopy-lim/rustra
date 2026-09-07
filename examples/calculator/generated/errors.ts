// ── rustra generated ────────────────────────────────────────
// File:   errors.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → ts error renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import { RustraCommandError } from '@rustra/types';

const divideErrorCodes: ReadonlySet<string> = new Set(['math.divide_by_zero']);

/** divide가 반환할 수 있는 도메인 에러 코드 (Rust 선언 기준). */
export const DivideErrorCode = {
  /** non-retryable. */
  MathDivideByZero: 'math.divide_by_zero',
} as const;
export type DivideErrorCode = (typeof DivideErrorCode)[keyof typeof DivideErrorCode];

/** code 리터럴로 좁혀진 divide의 에러 (discriminated by `code`). */
export type DivideError = RustraCommandError & { readonly code: DivideErrorCode };

/**
 * catch 분기용 타입 가드 — 미선언 코드(신규 네이티브 등)는 false.
 * 런타임은 개방 계약, 타입은 폐쇄 유니언 — 폴백은 err.code 문자열 분기.
 */
export function isDivideError(error: unknown): error is DivideError {
  return error instanceof RustraCommandError && divideErrorCodes.has(error.code);
}

const resourceReadErrorCodes: ReadonlySet<string> = new Set(['resource.not_found']);

/** resourceRead가 반환할 수 있는 도메인 에러 코드 (Rust 선언 기준). */
export const ResourceReadErrorCode = {
  /** non-retryable. */
  ResourceNotFound: 'resource.not_found',
} as const;
export type ResourceReadErrorCode = (typeof ResourceReadErrorCode)[keyof typeof ResourceReadErrorCode];

/** code 리터럴로 좁혀진 resourceRead의 에러 (discriminated by `code`). */
export type ResourceReadError = RustraCommandError & { readonly code: ResourceReadErrorCode };

/**
 * catch 분기용 타입 가드 — 미선언 코드(신규 네이티브 등)는 false.
 * 런타임은 개방 계약, 타입은 폐쇄 유니언 — 폴백은 err.code 문자열 분기.
 */
export function isResourceReadError(error: unknown): error is ResourceReadError {
  return error instanceof RustraCommandError && resourceReadErrorCodes.has(error.code);
}

const resourceWriteErrorCodes: ReadonlySet<string> = new Set(['resource.not_found']);

/** resourceWrite가 반환할 수 있는 도메인 에러 코드 (Rust 선언 기준). */
export const ResourceWriteErrorCode = {
  /** non-retryable. */
  ResourceNotFound: 'resource.not_found',
} as const;
export type ResourceWriteErrorCode = (typeof ResourceWriteErrorCode)[keyof typeof ResourceWriteErrorCode];

/** code 리터럴로 좁혀진 resourceWrite의 에러 (discriminated by `code`). */
export type ResourceWriteError = RustraCommandError & { readonly code: ResourceWriteErrorCode };

/**
 * catch 분기용 타입 가드 — 미선언 코드(신규 네이티브 등)는 false.
 * 런타임은 개방 계약, 타입은 폐쇄 유니언 — 폴백은 err.code 문자열 분기.
 */
export function isResourceWriteError(error: unknown): error is ResourceWriteError {
  return error instanceof RustraCommandError && resourceWriteErrorCodes.has(error.code);
}
