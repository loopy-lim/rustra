// ── rustra generated ────────────────────────────────────────
// File:   commands.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  rust-probe schema → ts renderer
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

import type { CreateItemInput, CreateItemOutput, DeleteItemInput, DeleteItemOutput, GetItemInput, GetItemOutput, ListItemsInput, ListItemsOutput, UpdateItemInput, UpdateItemOutput } from './types.js';
import { createGeneratedFields2, invokeGenerated, invokeGeneratedFields1 } from '@rustra/types';
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

export const createItem = createGeneratedFields2<CreateItemInput, CreateItemOutput>(1, 'createItem', "name", "value", 'createItem');

export function deleteItem(input: DeleteItemInput, options?: InvokeOptions): Promise<DeleteItemOutput> {
  return invokeGeneratedFields1<DeleteItemOutput>(5, 'deleteItem', input, input["id"], options);
}
deleteItem.commandId = 'deleteItem';

export function getItem(input: GetItemInput, options?: InvokeOptions): Promise<GetItemOutput> {
  return invokeGeneratedFields1<GetItemOutput>(2, 'getItem', input, input["id"], options);
}
getItem.commandId = 'getItem';

export function listItems(input: ListItemsInput, options?: InvokeOptions): Promise<ListItemsOutput> {
  return invokeGenerated<ListItemsOutput>(3, 'listItems', input, options);
}
listItems.commandId = 'listItems';

export function updateItem(input: UpdateItemInput, options?: InvokeOptions): Promise<UpdateItemOutput> {
  return invokeGenerated<UpdateItemOutput>(4, 'updateItem', input, options);
}
updateItem.commandId = 'updateItem';
