/**
 * scriptc 형태 표면의 데이터 모듈 — 클래스/콜백/제외 타입과 골드 심볼 테이블이
 * 한 곳에 산다. cli-generate-scriptc.ts 가 타입을 재수출해 기존 import 경로가
 * 유지된다.
 */

/**
 * 매니페스트가 받아들이는 타입 클래스(scriptc.dev/docs/ffi 표) 중 현재 표면이
 * 쓰는 것. `bool` 은 C ABI uint8_t, `mutable-bytes` 는 정확한 뷰(len=capacity)의
 * 쓰기 가능한 borrow다. 새 심볼이 다른 클래스(u16/bytes 등)를 요구하면 여기서
 * 확장한다 — 선제적 나열 금지.
 */
export type ScriptcFfiType =
  'bool' | 'i32' | 'u32' | 'u64' | 'string' | 'cstring' | 'bytes' | 'mutable-bytes';

export type ScriptcCallback = {
  id: string;
  params: (ScriptcFfiType | { context: string })[];
  returns: ScriptcFfiType | 'void';
  lifetime: 'retained';
  invoke: 'foreign';
};
export type ScriptcParameter =
  ScriptcFfiType | { context: string } | { callback: ScriptcCallback | { release: string } };

/** scriptc 형태 표면에서 제외된 심볼과 그 이유. */
export type ScriptcExcludedSymbol = {
  symbol: string;
  reason: string;
};

/**
 * 매니페스트에 실리는 scriptc 형태 심볼 목록 — 골드 데이터다. 시그니처 출처:
 * crates/rustra/src/ffi_{sync,typed,lifecycle,schema}_entries.rs. 맨 앞의
 * rustra_mobile_init 은 `rustra::native_entry!` 가 모든 소비 크레이트에 노출하는
 * 균일 초기화 진입이고, rustra_ffi_invoke_json_into_len 은 caller-buffer envelope
 * 진입(ffi_sync_entries.rs — out 포인터 대신 길이를 반환)이다.
 */
export const RUSTRA_FFI_SYNC_SYMBOLS: readonly {
  symbol: string;
  params: readonly (readonly [ScriptcParameter, string])[]; // [클래스, 파라미터명]
  returns: ScriptcFfiType | 'void';
}[] = [
  { symbol: 'rustra_mobile_init', params: [], returns: 'void' },
  {
    symbol: 'rustra_ffi_invoke_json_into_len',
    params: [
      ['string', 'payload'],
      ['mutable-bytes', 'buf'],
    ],
    returns: 'u64',
  },
  { symbol: 'rustra_ffi_schema_generation', params: [], returns: 'u64' },
  { symbol: 'rustra_ffi_get_max_payload', params: [], returns: 'u64' },
  { symbol: 'rustra_ffi_set_max_payload', params: [['u64', 'bytes']], returns: 'void' },
  { symbol: 'rustra_ffi_invoke_cancel', params: [['u64', 'invocation_id']], returns: 'bool' },
  { symbol: 'rustra_ffi_cancellation_status', params: [['u64', 'invocation_id']], returns: 'u32' },
  {
    symbol: 'rustra_ffi_channel_create_bytes',
    params: [
      [
        {
          callback: {
            id: 'receive',
            params: [{ context: 'receive' }, 'u32', 'bytes'],
            returns: 'void',
            lifetime: 'retained',
            invoke: 'foreign',
          },
        },
        'receive',
      ],
      [{ context: 'receive' }, 'context'],
    ],
    returns: 'u32',
  },
  {
    symbol: 'rustra_ffi_channel_release_scriptc',
    params: [
      [{ callback: { release: 'rustra_ffi_channel_create_bytes:receive' } }, 'receive'],
      [{ context: 'rustra_ffi_channel_create_bytes:receive' }, 'context'],
    ],
    returns: 'void',
  },
  {
    symbol: 'rustra_ffi_channel_send_bytes',
    params: [
      ['u32', 'handle'],
      ['bytes', 'payload'],
    ],
    returns: 'i32',
  },
  {
    symbol: 'rustra_ffi_invoke_json_async_channel',
    params: [
      ['string', 'payload'],
      ['u32', 'channel'],
    ],
    returns: 'u64',
  },
  {
    symbol: 'rustra_ffi_event_sink_register_scriptc',
    params: [
      [
        {
          callback: {
            id: 'event',
            params: [{ context: 'event' }, 'cstring', 'cstring'],
            returns: 'void',
            lifetime: 'retained',
            invoke: 'foreign',
          },
        },
        'onEvent',
      ],
      [{ context: 'event' }, 'context'],
    ],
    returns: 'void',
  },
  {
    symbol: 'rustra_ffi_event_sink_release_scriptc',
    params: [
      [{ callback: { release: 'rustra_ffi_event_sink_register_scriptc:event' } }, 'onEvent'],
      [{ context: 'rustra_ffi_event_sink_register_scriptc:event' }, 'context'],
    ],
    returns: 'void',
  },
];

/** out 포인터에 쓰는 심볼의 공통 사유 — scriptc 형태 대체재를 함께 명시한다. */
const OUT_POINTER_REASON =
  'writes through an out-pointer — scriptc direct-call supplies pointer args only as ' +
  'bigint addresses with no caller-addressable scratch primitive; use ' +
  'rustra_ffi_invoke_json_into_len for the caller-buffer contract';

/**
 * scriptc 형태 표면에서 의도적으로 제외한 심볼들 — "지원되지 않음"의 기록이다.
 * 두 그룹: (1) 소유 응답/out 포인터 async 또는 C-unwind 콜백 — 차용 콜백
 * sibling으로만 노출한다. (2) out 포인터에
 * 쓰는 심볼 — 위 OUT_POINTER_REASON 참조.
 */
export const scriptcExcludedSymbols: readonly ScriptcExcludedSymbol[] = [
  {
    symbol: 'rustra_ffi_invoke',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_invoke_json',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_invoke_frame',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_invoke_json_into',
    reason: `${OUT_POINTER_REASON} (the _len variant is the scriptc-shaped form of this symbol)`,
  },
  {
    symbol: 'rustra_ffi_invoke_frame_into',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_invoke_frame_owned',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_invoke_buffer',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_invoke_raw',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_invoke_postcard',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_hot_reload',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_get_schema',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_contract_hash',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_capture_snapshot',
    reason: OUT_POINTER_REASON,
  },
  {
    symbol: 'rustra_ffi_free',
    reason:
      'pointer parameter — the only pointer producer (invoke* owned responses) is itself excluded',
  },
  {
    symbol: 'rustra_ffi_free_owned_bytes',
    reason:
      'pointer parameter — the only pointer producer (invoke* owned responses) is itself excluded',
  },
  {
    symbol: 'rustra_ffi_invoke_async',
    reason:
      'owned response/out-pointer completion — use rustra_ffi_invoke_json_async_channel for borrowed delivery',
  },
  {
    symbol: 'rustra_ffi_invoke_json_async',
    reason:
      'owned response/out-pointer completion — use rustra_ffi_invoke_json_async_channel for borrowed delivery',
  },
  {
    symbol: 'rustra_ffi_invoke_frame_async',
    reason:
      'owned response/out-pointer completion — use rustra_ffi_invoke_json_async_channel for borrowed delivery',
  },
  {
    symbol: 'rustra_ffi_invoke_frame_async_into',
    reason:
      'owned response/out-pointer completion — use rustra_ffi_invoke_json_async_channel for borrowed delivery',
  },
  {
    symbol: 'rustra_ffi_event_sink_register',
    reason: 'C-unwind callback — use the plain C rustra_ffi_event_sink_register_scriptc sibling',
  },
  {
    symbol: 'rustra_ffi_event_sink_unregister',
    reason: 'pairs with rustra_ffi_event_sink_register; registering is already excluded',
  },
  {
    symbol: 'rustra_ffi_channel_create',
    reason: 'callback function pointer parameter — needs the format 5 foreign-thread contract',
  },
  {
    symbol: 'rustra_ffi_channel_send',
    reason: 'pairs with rustra_ffi_channel_create (excluded callback contract)',
  },
  {
    symbol: 'rustra_ffi_channel_drop',
    reason:
      'pairs with retained callbacks; use rustra_ffi_channel_release_scriptc to unpin the callback identity',
  },
];
