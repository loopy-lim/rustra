/**
 * scriptc Native FFI 코드젠 — rustra 스키마에서 scriptc(0.2.x, ffi_format 7)가
 * 링크할 아티팩트 두 벌을 렌더한다:
 *
 *   1. ffi.json   — 심볼/타입 매니페스트. libraries 는 rustra staticlib
 *                   아카이브 경로(resolveScriptcArchivePath)를 가리키며,
 *                   scriptc 가 출력 파일 위치 기준 상대경로로 해석한다.
 *   2. scriptc-ffi.d.ts — 시그니처-only TS 선언. 구현은 아카이브가 링크 시
 *                   제공하고, 런타임 symbol lookup 은 없다(정적 링크 계약).
 *
 * scriptc는 napi 애드온과 dlopen 을 지원하지 않으므로 Node/Bun 호스트 코드젠
 * (bun.ts/node.ts 의 bun:ffi + dlopen 계약)을 재사용할 수 없다 — 이 모듈이
 * 유일한 scriptc 경로다. 조사 근거: docs/dev/plans/2026-10-03-scriptc-integration-notes.md.
 *
 * 왜 ffi_format 7 인가 — scriptc.dev/docs/ffi 기준(2026-10 확인) mutable-bytes 는
 * format 6+, u64 는 format 7 이다. caller-buffer envelope 진입
 * (rustra_ffi_invoke_json_into_len)이 `string`(payload 의 `(ptr,len)` 접기) +
 * `mutable-bytes`(buf/capacity 의 쓰기 가능한 borrow) + `u64` 반환(기록 바이트 수,
 * usize)로 정확히 이 세 클래스에 걸린다. 매니페스트는 scriptc 가 검증하므로
 * 잘못된 클래스는 `scriptc build` 에서 즉시 깨진다 — 실증 게이트는
 * examples/calculator/scriptc/run.sh (응답 42).
 *
 * scriptc 형태(scriptc-shaped) 판별 — 매니페스트에는 scriptc 직접 호출 세계가
 * 실제로 공급할 수 있는 인자만 싣는다:
 *   - 포인터 클래스 인자는 bigint 주소뿐인데, 직접 세계에 caller 가 쓰기 가능한
 *     외부 메모리 주소를 얻는 프리미티브가 없다(getRawPointer/toArrayBuffer 는
 *     node:ffi 카탈로그 세계 전용). 그래서 out 포인터에 쓰는 심볼
 *     (invoke_json_into 의 out_len, get_schema/contract_hash 의 out_len,
 *     invoke_buffer/invoke_raw 의 이중 포인터)은 전부 제외 대상이고, 그 대체로
 *     코어가 `rustra_ffi_invoke_json_into_len`(길이를 반환값으로)을 제공한다.
 *   - 콜백 함수 포인터 인자(async*, event_sink_*, channel_create*)는 callback
 *     descriptor 계약(format 2+, 외부 스레드는 format 5)이라 제외다.
 * 두 제외 목록 모두 scriptcExcludedSymbols 에 사유와 함께 기록된다.
 *
 * 함수 목록은 스키마 커맨드별이 아니라 rustra 의 고정 C ABI(envelope dispatch —
 * 커맨드 식별은 JSON/command_id 로 내부에서 일어난다)에서 scriptc 형태 심볼만
 * 모은 골드 데이터다. 테스트가 이 순서를 고정하며, 재배열은 소비자(scriptc
 * 아카이브 링크)에 드리프트로 보이므로 append-only 로 성장한다.
 */
import { resolve } from 'node:path';
import { generatedFileHeader } from './generated-header.js';
import type { PackageSchema } from './schema.js';

/**
 * 매니페스트 포맷 버전 — 7 은 u64 클래스를 켜고(6+ 는 mutable-bytes), scriptc
 * 버전업 시 골드 데이터 테스트가 이 상수를 검증하므로 여기서 깨진다.
 */
export const SCRIPTC_FFI_FORMAT = 7;

/** 생성되는 ffi.json 의 커밋 파일명 — scriptc 빌드의 매니페스트 진입점. */
export const SCRIPTC_MANIFEST_FILE = 'ffi.json';

/** 생성되는 시그니처-only TS 선언의 커밋 파일명. */
export const SCRIPTC_DECLARATIONS_FILE = 'scriptc-ffi.d.ts';

/**
 * 매니페스트가 받아들이는 타입 클래스(scriptc.dev/docs/ffi 표) 중 현재 표면이
 * 쓰는 것. `bool` 은 C ABI uint8_t, `mutable-bytes` 는 정확한 뷰(len=capacity)의
 * 쓰기 가능한 borrow다. 새 심볼이 다른 클래스(u16/bytes 등)를 요구하면 여기서
 * 확장한다 — 선제적 나열 금지.
 */
export type ScriptcFfiType = 'bool' | 'u32' | 'u64' | 'string' | 'mutable-bytes';

/** 함수 엔트리 — params 는 C 인자 순서의 (포인터, 길이) 쌍을 접은 플랫 배열이다. */
export type ScriptcFunctionEntry = {
  /** 매니페스트와 TS 선언이 공유하는 함수 식별자 — rustra 는 심볼명과 동일하다. */
  name: string;
  symbol: string;
  params: ScriptcFfiType[];
  /** void 함수는 'void', 그 외는 ScriptcFfiType. */
  returns: ScriptcFfiType | 'void';
};

export type ScriptcFfiManifest = {
  ffi_format: typeof SCRIPTC_FFI_FORMAT;
  functions: ScriptcFunctionEntry[];
  /** 정적 링크할 아카이브 경로 — rustra staticlib 산출물(resolveScriptcArchivePath). */
  libraries: string[];
  /** 시스템 라이브러리 — rustra staticlib 는 링커 기본 의존만 가진다(빈 배열 고정). */
  system_libraries: string[];
};

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
const RUSTRA_FFI_SYNC_SYMBOLS: readonly {
  symbol: string;
  params: readonly (readonly [ScriptcFfiType, string])[]; // [클래스, 파라미터명]
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
];

/** out 포인터에 쓰는 심볼의 공통 사유 — scriptc 형태 대체재를 함께 명시한다. */
const OUT_POINTER_REASON =
  'writes through an out-pointer — scriptc direct-call supplies pointer args only as ' +
  'bigint addresses with no caller-addressable scratch primitive; use ' +
  'rustra_ffi_invoke_json_into_len for the caller-buffer contract';

/**
 * scriptc 형태 표면에서 의도적으로 제외한 심볼들 — "지원되지 않음"의 기록이다.
 * 두 그룹: (1) 콜백 함수 포인터 인자 — callback descriptor 는 format 2+, 외부
 * 스레드는 format 5(foreign-thread + retained + context) 계약이라 Rust
 * `extern "C" fn` + `*mut c_void` 모델을 억지로 넣지 않는다. (2) out 포인터에
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
    reason: 'on_complete callback function pointer — needs the format 2+ callback descriptor',
  },
  {
    symbol: 'rustra_ffi_invoke_json_async',
    reason: 'on_complete callback function pointer — needs the format 2+ callback descriptor',
  },
  {
    symbol: 'rustra_ffi_invoke_frame_async',
    reason: 'on_complete callback function pointer — needs the format 2+ callback descriptor',
  },
  {
    symbol: 'rustra_ffi_invoke_frame_async_into',
    reason: 'on_complete callback function pointer — needs the format 2+ callback descriptor',
  },
  {
    symbol: 'rustra_ffi_event_sink_register',
    reason: 'callback function pointer parameter — needs the format 2+ callback descriptor',
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
    symbol: 'rustra_ffi_channel_create_bytes',
    reason: 'callback function pointer parameter — needs the format 5 foreign-thread contract',
  },
  {
    symbol: 'rustra_ffi_channel_send_bytes',
    reason: 'pairs with rustra_ffi_channel_create (excluded callback contract)',
  },
  {
    symbol: 'rustra_ffi_channel_send',
    reason: 'pairs with rustra_ffi_channel_create (excluded callback contract)',
  },
  {
    symbol: 'rustra_ffi_channel_drop',
    reason: 'pairs with rustra_ffi_channel_create (excluded callback contract)',
  },
];

/** rustra FFI 심볼 테이블 → ffi_format 7 functions 엔트리 목록. */
export function generateScriptcFunctions(): ScriptcFunctionEntry[] {
  return RUSTRA_FFI_SYNC_SYMBOLS.map(({ symbol, params, returns }) => ({
    name: symbol,
    symbol,
    params: params.map(([ffiType]) => ffiType),
    returns,
  }));
}

/** 심볼 → 파라미터명 목록 — 선언의 가독성 있는 `name: type` 시그니처 근거. */
const SCRIPTC_PARAM_NAMES: ReadonlyMap<string, readonly string[]> = new Map(
  RUSTRA_FFI_SYNC_SYMBOLS.map(({ symbol, params }) => [symbol, params.map(([, name]) => name)]),
);

/**
 * staticlib 아카이브 경로 해석 — uniffi 의 expectedDylibPath 와 같은 크레이트명→
 * 파일명 규약(하이픈→밑줄)을 staticlib 에 적용한다: target/<profile>/lib<name>.a.
 * 예: rustra-calculator-example → target/release/librustra_calculator_example.a.
 */
export function resolveScriptcArchivePath(
  targetDir: string,
  packageName: string,
  profile: 'debug' | 'release' = 'release',
): string {
  return resolve(targetDir, profile, `lib${packageName.replace(/-/g, '_')}.a`);
}

/** ffi.json 매니페스트 생성 — 함수 목록은 고정 심볼 테이블, libraries 는 아카이브 1건. */
export function generateScriptcManifest(archivePath: string): ScriptcFfiManifest {
  return {
    ffi_format: SCRIPTC_FFI_FORMAT,
    functions: generateScriptcFunctions(),
    libraries: [archivePath],
    system_libraries: [],
  };
}

export type ScriptcArtifacts = {
  manifest: ScriptcFfiManifest;
  /** ffi.json 직렬화(bytes 안정 — JSON 에는 헤더를 각인하지 않는 관례). */
  ffiJson: string;
  /** scriptc-ffi.d.ts 직렬화(generatedFileHeader 각인). */
  declarations: string;
};

export type ScriptcGenerateInput = {
  /** 코드젠 스키마 — packageId 가 선언 헤더의 근거로 각인된다. */
  schema: PackageSchema;
  /** 정적 링크할 staticlib 아카이브 경로(resolveScriptcArchivePath 산출물). */
  archivePath: string;
};

/**
 * 스키마에서 scriptc FFI 아티팩트 두 벌을 렌더한다. 커맨드별 래퍼를 만들지 않는
 * 이유: rustra FFI 는 envelope dispatch(JSON/command_id)라 와이어 진입점이
 * 패키지마다 동일하다. 스키마의 역할은 packageId 근거와 빈 커맨드 fail-closed
 * 검증뿐이다. 쓰기는 오케스트레이터(cli-scriptc.ts)의 몫 — 이 모듈은 문자열만
 * 렌더해 scriptc 바이너리 없이 검증 가능하게 유지한다.
 */
export function generateScriptcArtifacts(input: ScriptcGenerateInput): ScriptcArtifacts {
  const { schema, archivePath } = input;
  if (!schema.packageId) throw new Error('schema.packageId is required for scriptc artifacts');
  if (schema.commands.length === 0)
    throw new Error(`schema ${schema.packageId} declares no commands — nothing to expose via FFI`);
  const manifest = generateScriptcManifest(archivePath);
  return {
    manifest,
    ffiJson: renderScriptcFfiJson(manifest),
    declarations: renderScriptcDeclarations(manifest, schema.packageId, schema.schemaVersion),
  };
}

/** ffi.json 직렬화 — JSON 산출물엔 헤더를 각인하지 않는다(generated-header.ts 계약). */
export function renderScriptcFfiJson(manifest: ScriptcFfiManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** 매니페스트 클래스 → 선언의 TS 타입(scriptc.dev/docs/ffi 표의 1:1 매핑). */
export function toScriptcTsType(type: ScriptcFfiType | 'void'): string {
  switch (type) {
    case 'void':
      return 'void';
    case 'string':
      return 'string';
    case 'mutable-bytes':
      return 'Uint8Array';
    case 'bool':
      return 'boolean';
    case 'u32':
      return 'number';
    case 'u64':
      return 'bigint';
  }
}

/** 시그니처-only TS 선언 직렬화 — declare function 만 있고 구현은 없다. */
export function renderScriptcDeclarations(
  manifest: ScriptcFfiManifest,
  packageId: string,
  schemaVersion?: number,
): string {
  const body = [
    `// scriptc Native FFI 시그니처 선언 — 구현은 ffi.json 의 libraries 아카이브가`,
    `// 링크 시 제공한다(정적 링크, 런타임 symbol lookup 없음). 이 파일을 직접`,
    `// 구현 파일로 쓰지 않는다. 매핑 근거와 제외된 콜백/out 포인터 심볼 목록은`,
    `// cli-generate-scriptc.ts 의 scriptcExcludedSymbols 주석을 참조한다.`,
    `//`,
    `// 근거 스키마: ${packageId}${schemaVersion === undefined ? '' : ` (schemaVersion ${schemaVersion})`}`,
    ``,
    ...manifest.functions.map((entry) => renderDeclaration(entry)),
  ].join('\n');
  return `${generatedFileHeader(SCRIPTC_DECLARATIONS_FILE, 'schema → scriptc ffi declarations')}${body}\n`;
}

function renderDeclaration(entry: ScriptcFunctionEntry): string {
  // 매니페스트는 이름 없는 클래스 배열이지만 선언은 `name: type` 으로 렌더한다 —
  // 이름은 같은 심볼 테이블에서 병렬로 온다(무명 파라미터는 implicit any 로 읽힌다).
  const names = SCRIPTC_PARAM_NAMES.get(entry.symbol);
  if (!names || names.length !== entry.params.length)
    throw new Error(
      `scriptc param-name table is out of sync for ${entry.symbol} — ` +
        `RUSTRA_FFI_SYNC_SYMBOLS is the single source for both manifest and declarations`,
    );
  const params = entry.params
    .map((type, index) => `${names[index]}: ${toScriptcTsType(type)}`)
    .join(', ');
  return `declare function ${entry.name}(${params}): ${toScriptcTsType(entry.returns)};`;
}
