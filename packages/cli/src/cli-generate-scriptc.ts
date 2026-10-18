/**
 * scriptc Native FFI 코드젠 — rustra 스키마에서 scriptc(0.2.x, ffi_format 7)가
 * 링크할 매니페스트와 선언을 렌더한다:
 *
 *   1. ffi.json   — 심볼/타입 매니페스트. libraries 는 rustra staticlib
 *                   아카이브 경로(resolveScriptcArchivePath)를 가리키며,
 *                   scriptc 가 출력 파일 위치 기준 상대경로로 해석한다.
 *   2. scriptc-ffi.ts / .d.ts — source import / legacy ambient 선언. 구현은 아카이브가 링크 시
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
 *   - 소유 응답/out 포인터 async와 C-unwind 이벤트는 직접 노출하지 않는다.
 *     borrowed bytes channel과 plain C event sibling을 retained/foreign callback
 *     descriptor로 제공하고 identity-paired release가 closure 수명을 닫는다.
 * 두 제외 목록 모두 scriptcExcludedSymbols 에 사유와 함께 기록된다.
 *
 * 함수 목록은 스키마 커맨드별이 아니라 rustra 의 고정 C ABI(envelope dispatch —
 * 커맨드 식별은 JSON/command_id 로 내부에서 일어난다)에서 scriptc 형태 심볼만
 * 모은 골드 데이터다. 테스트가 이 순서를 고정하며, 재배열은 소비자(scriptc
 * 아카이브 링크)에 드리프트로 보이므로 append-only 로 성장한다.
 */
import { resolve } from 'node:path';
import { generatedFileHeader } from './generated-header.js';
import { RUSTRA_FFI_SYNC_SYMBOLS } from './scriptc-symbols.js';
import type { ScriptcFfiType, ScriptcParameter } from './scriptc-symbols.js';
import type { PackageSchema } from './schema.js';

// 골드 데이터와 그 타입은 scriptc-symbols.ts 가 소유한다 — 여기선 렌더에 쓰고
// 기존 import 경로를 위해 재수출한다.
export type {
  ScriptcCallback,
  ScriptcExcludedSymbol,
  ScriptcFfiType,
  ScriptcParameter,
} from './scriptc-symbols.js';

/**
 * 매니페스트 포맷 버전 — 7 은 u64 클래스를 켜고(6+ 는 mutable-bytes), scriptc
 * 버전업 시 골드 데이터 테스트가 이 상수를 검증하므로 여기서 깨진다.
 */
export const SCRIPTC_FFI_FORMAT = 7;

/** 생성되는 ffi.json 의 커밋 파일명 — scriptc 빌드의 매니페스트 진입점. */
export const SCRIPTC_MANIFEST_FILE = 'ffi.json';

/** 생성되는 시그니처-only TS 선언의 커밋 파일명. */
export const SCRIPTC_DECLARATIONS_FILE = 'scriptc-ffi.d.ts';
/** Callback types must live in a source file: scriptc 0.2.1 cannot map them from .d.ts. */
export const SCRIPTC_SOURCE_FILE = 'scriptc-ffi.ts';

/** 함수 엔트리 — params 는 C 인자 순서의 (포인터, 길이) 쌍을 접은 플랫 배열이다. */
export type ScriptcFunctionEntry = {
  /** 매니페스트와 TS 선언이 공유하는 함수 식별자 — rustra 는 심볼명과 동일하다. */
  name: string;
  symbol: string;
  params: ScriptcParameter[];
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

export { scriptcExcludedSymbols } from './scriptc-symbols.js';

/** rustra FFI 심볼 테이블 → ffi_format 7 functions 엔트리 목록. */
export function generateScriptcFunctions(): ScriptcFunctionEntry[] {
  return RUSTRA_FFI_SYNC_SYMBOLS.map(({ symbol, params, returns }) => ({
    name: symbol,
    symbol,
    params: params.map(([ffiType]) => structuredClone(ffiType)),
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
  /** scriptc-ffi.ts 원본 직렬화(generatedFileHeader 각인 — .d.ts 는 파일명·export 접두만 바꾼 ambient 변형). */
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
    case 'cstring':
      return 'string';
    case 'bytes':
    case 'mutable-bytes':
      return 'Uint8Array';
    case 'bool':
      return 'boolean';
    case 'i32':
    case 'u32':
      return 'number';
    case 'u64':
      return 'bigint';
  }
}

/** 시그니처-only TS 선언 직렬화 — export declare function 만 있고 구현은 없다. */
export function renderScriptcDeclarations(
  manifest: ScriptcFfiManifest,
  packageId: string,
  schemaVersion?: number,
): string {
  const body = [
    `// scriptc Native FFI 시그니처 선언 — 구현은 ffi.json 의 libraries 아카이브가`,
    `// 링크 시 제공한다(정적 링크, 런타임 symbol lookup 없음). source import(.ts)와`,
    `// legacy ambient(.d.ts) 양쪽이 이 원본에서 파생된다. 매핑 근거와 제외된`,
    `// 콜백/out 포인터 심볼 목록은 scriptc-symbols.ts 의 scriptcExcludedSymbols`,
    `// 주석을 참조한다.`,
    `//`,
    `// 근거 스키마: ${packageId}${schemaVersion === undefined ? '' : ` (schemaVersion ${schemaVersion})`}`,
    ``,
    ...manifest.functions.map((entry) => renderDeclaration(entry, manifest)),
  ].join('\n');
  return `${generatedFileHeader(SCRIPTC_SOURCE_FILE, 'schema → scriptc ffi declarations')}${body}\n`;
}

function renderDeclaration(entry: ScriptcFunctionEntry, manifest: ScriptcFfiManifest): string {
  // 매니페스트는 이름 없는 클래스 배열이지만 선언은 `name: type` 으로 렌더한다 —
  // 이름은 같은 심볼 테이블에서 병렬로 온다(무명 파라미터는 implicit any 로 읽힌다).
  const names = SCRIPTC_PARAM_NAMES.get(entry.symbol);
  if (!names || names.length !== entry.params.length)
    throw new Error(
      `scriptc param-name table is out of sync for ${entry.symbol} — ` +
        `RUSTRA_FFI_SYNC_SYMBOLS is the single source for both manifest and declarations`,
    );
  const params = entry.params
    .flatMap((type, index) => {
      if (typeof type === 'object' && 'context' in type) return [];
      if (typeof type === 'string') return [`${names[index]}: ${toScriptcTsType(type)}`];
      let callback = type.callback;
      if ('release' in callback) {
        const [binding, id] = callback.release.split(':');
        const owner = manifest.functions.find((fn) => fn.name === binding);
        const source = owner?.params.find(
          (param) =>
            typeof param === 'object' &&
            'callback' in param &&
            'id' in param.callback &&
            param.callback.id === id,
        );
        if (
          !source ||
          typeof source === 'string' ||
          !('callback' in source) ||
          !('id' in source.callback)
        )
          throw new Error(`Unknown scriptc callback release ${callback.release}`);
        callback = source.callback;
      }
      const values = callback.params.filter(
        (param): param is ScriptcFfiType => typeof param === 'string',
      );
      return [
        `${names[index]}: (${values.map((param, i) => `value${i}: ${toScriptcTsType(param)}`).join(', ')}) => ${toScriptcTsType(callback.returns)}`,
      ];
    })
    .join(', ');
  return `export declare function ${entry.name}(${params}): ${toScriptcTsType(entry.returns)};`;
}
