// ── rustra generated ────────────────────────────────────────
// File:   scriptc-ffi.d.ts
// Source: schema.json (single source of truth for this file)
// Regen:  rustra codegen --config rustra.json
// Stage:  schema → scriptc ffi declarations
// DO NOT EDIT — changes will be overwritten and fail codegen --check.
// ────────────────────────────────────────────────────────────

// scriptc Native FFI 시그니처 선언 — 구현은 ffi.json 의 libraries 아카이브가
// 링크 시 제공한다(정적 링크, 런타임 symbol lookup 없음). source import(.ts)와
// legacy ambient(.d.ts) 양쪽이 이 원본에서 파생된다. 매핑 근거와 제외된
// 콜백/out 포인터 심볼 목록은 scriptc-symbols.ts 의 scriptcExcludedSymbols
// 주석을 참조한다.
//
// 근거 스키마: examples.calculator (schemaVersion 1)

declare function rustra_mobile_init(): void;
declare function rustra_ffi_invoke_json_into_len(payload: string, buf: Uint8Array): bigint;
declare function rustra_ffi_schema_generation(): bigint;
declare function rustra_ffi_get_max_payload(): bigint;
declare function rustra_ffi_set_max_payload(bytes: bigint): void;
declare function rustra_ffi_invoke_cancel(invocation_id: bigint): boolean;
declare function rustra_ffi_cancellation_status(invocation_id: bigint): number;
declare function rustra_ffi_channel_create_bytes(receive: (value0: number, value1: Uint8Array) => void): number;
declare function rustra_ffi_channel_release_scriptc(receive: (value0: number, value1: Uint8Array) => void): void;
declare function rustra_ffi_channel_send_bytes(handle: number, payload: Uint8Array): number;
declare function rustra_ffi_invoke_json_async_channel(payload: string, channel: number): bigint;
declare function rustra_ffi_event_sink_register_scriptc(onEvent: (value0: string, value1: string) => void): void;
declare function rustra_ffi_event_sink_release_scriptc(onEvent: (value0: string, value1: string) => void): void;
