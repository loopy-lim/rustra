// rustra.json 계약의 데이터 절 — 허용 키 상수·파생 타입·섹션 인터페이스만 둔다.
// 검증 로직은 config.ts(L1 진입)·config-sections.ts(L1 섹션)·config-semantic.ts(L2)가 담당한다.

/** rustra.json 루트 허용 키 — L1 fail-closed의 단일 출처(스키마 대조 테스트가 함께 읽는다). */
export const CONFIG_ROOT_KEYS = [
  '$schema',
  'schema',
  'output',
  'cppOutput',
  'positional',
  'codegen',
  'reactNative',
  'node',
  'bun',
  'tauri',
  'dev',
  'inspector',
  'uniffi',
] as const;
export const CODEGEN_CONFIG_KEYS = ['rustManifest', 'rustPackage', 'rustBinary'] as const;
export const UNIFFI_CONFIG_KEYS = ['output', 'srcOut', 'dylibProfile'] as const;
export const DYLIB_PROFILES = ['debug', 'release'] as const;
export const REACT_NATIVE_CONFIG_KEYS = [
  'moduleDir',
  'rustManifest',
  'rustPackage',
  'rustLibrary',
] as const;
export const NODE_CONFIG_KEYS = ['rustManifest', 'rustPackage', 'rustBinary', 'args'] as const;
export const BUN_CONFIG_KEYS = ['rustManifest', 'rustPackage', 'rustLibrary'] as const;
export const DEV_CONFIG_KEYS = ['target', 'wasm', 'dylib'] as const;
export const DEV_WASM_CONFIG_KEYS = ['engine', 'parityGate'] as const;
export const DEV_DYLIB_CONFIG_KEYS = ['parityGate'] as const;
export const INSPECTOR_CONFIG_KEYS = ['onMismatch'] as const;
export const DEV_TARGETS = ['native', 'wasm', 'dylib'] as const;
export const WASM_ENGINES = ['wasm3'] as const;
export const ON_MISMATCH_VALUES = ['diagnose', 'ignore'] as const;

// 열거형 타입은 상수 배열에서 파생 — 배열만 고치면 타입·검증·스키마가 함께 따라간다.
export type DevTarget = (typeof DEV_TARGETS)[number];
export type WasmEngine = (typeof WASM_ENGINES)[number];
export type OnMismatch = (typeof ON_MISMATCH_VALUES)[number];
export type DylibProfile = (typeof DYLIB_PROFILES)[number];

export interface DevWasmConfig {
  engine?: WasmEngine;
  parityGate?: boolean;
}

export interface DevDylibConfig {
  parityGate?: boolean;
}

export interface DevConfig {
  target?: DevTarget;
  wasm?: DevWasmConfig;
  dylib?: DevDylibConfig;
}

export interface InspectorConfig {
  onMismatch?: OnMismatch;
}

/**
 * uniffi 섹션 — UniFFI Kotlin/Swift 바인딩 코드젠. 존재 자체가 기능 스위치다
 * (없으면 코드젠 흐름은 이전과 바이트 동일). 최소 옵션만 — 필요가 생기면 키를
 * 추가한다(선제적 옵션 금지).
 */
export interface RustraUniffiConfig {
  /** Kotlin/Swift 바인딩이 출력되는 디렉터리 — config 파일 위치 기준 상대경로. */
  output: string;
  /**
   * Rust 프로브가 uniffi_generated.rs 를 쓰는(그리고 커밋되는) 디렉터리 —
   * config 파일 위치 기준 상대경로로 schema/output 과 같은 관례를 따른다.
   * 하드코딩된 "src" 를 금지하기 위한 키다. 기본값 "src".
   */
  srcOut?: string;
  /** 바인딩 생성에 쓰이는 cdylib 빌드 프로필. 기본값 "debug". */
  dylibProfile?: DylibProfile;
}

export interface RustraConfig {
  /** JSON Schema 참조(init이 삽입) — 에디터 검증 전용이며 런타임은 읽지 않는다. */
  $schema?: string;
  schema: string;
  output: string;
  cppOutput?: string;
  positional?: boolean;
  codegen?: {
    rustManifest?: string;
    rustPackage?: string;
    rustBinary?: string;
  };
  reactNative?: {
    moduleDir?: string;
    rustManifest?: string;
    rustPackage?: string;
    rustLibrary?: string;
  };
  node?: {
    rustManifest?: string;
    rustPackage?: string;
    rustBinary?: string;
    args?: string[];
  };
  bun?: {
    rustManifest?: string;
    rustPackage?: string;
    rustLibrary?: string;
  };
  tauri?: Record<string, never>;
  dev?: DevConfig;
  inspector?: InspectorConfig;
  uniffi?: RustraUniffiConfig;
}
