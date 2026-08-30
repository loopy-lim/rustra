import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { closestMatch } from './cli-suggest.js';

/** rustra.json 루트 허용 키 — L1 fail-closed의 단일 출처(스키마 대조 테스트가 함께 읽는다). */
export const CONFIG_ROOT_KEYS = [
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
] as const;
export const CODEGEN_CONFIG_KEYS = ['rustManifest', 'rustPackage', 'rustBinary'] as const;
export const REACT_NATIVE_CONFIG_KEYS = [
  'moduleDir',
  'rustManifest',
  'rustPackage',
  'rustLibrary',
  'legacyBenchmarks',
] as const;
export const NODE_CONFIG_KEYS = ['rustManifest', 'rustPackage', 'rustBinary', 'args'] as const;
export const BUN_CONFIG_KEYS = ['rustManifest', 'rustPackage', 'rustLibrary'] as const;
export const DEV_CONFIG_KEYS = ['target', 'wasm'] as const;
export const DEV_WASM_CONFIG_KEYS = ['engine', 'parityGate'] as const;
export const INSPECTOR_CONFIG_KEYS = ['onMismatch'] as const;
export const DEV_TARGETS = ['native', 'wasm'] as const;
export const WASM_ENGINES = ['wasm3'] as const;
export const ON_MISMATCH_VALUES = ['diagnose', 'ignore'] as const;

// 열거형 타입은 상수 배열에서 파생 — 배열만 고치면 타입·검증·스키마가 함께 따라간다.
export type DevTarget = (typeof DEV_TARGETS)[number];
export type WasmEngine = (typeof WASM_ENGINES)[number];
export type OnMismatch = (typeof ON_MISMATCH_VALUES)[number];

export interface DevWasmConfig {
  engine?: WasmEngine;
  parityGate?: boolean;
}

export interface DevConfig {
  target?: DevTarget;
  wasm?: DevWasmConfig;
}

export interface InspectorConfig {
  onMismatch?: OnMismatch;
}

export interface RustraConfig {
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
    legacyBenchmarks?: boolean;
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
}

export function readConfigSync(configPath: string): RustraConfig {
  const content = readFileSync(resolve(configPath), 'utf-8');
  const parsed = JSON.parse(content) as unknown;
  assertKnownKeys(parsed, CONFIG_ROOT_KEYS, 'config');
  const config = parsed as RustraConfig;

  if (
    typeof config.schema !== 'string' ||
    config.schema.length === 0 ||
    typeof config.output !== 'string' ||
    config.output.length === 0
  ) {
    throw new Error(
      'Config file must have "schema" and "output" fields. Example:\n' +
        '{\n  "schema": "./generated/schema.json",\n  "output": "./src/generated"\n}',
    );
  }
  if (/[\0\r\n]/.test(config.schema) || /[\0\r\n]/.test(config.output)) {
    throw new Error('Config schema and output must be non-empty safe paths');
  }
  const codegen = config.codegen;
  if (codegen !== undefined) {
    assertKnownKeys(codegen, CODEGEN_CONFIG_KEYS, 'config codegen');
    if (typeof codegen !== 'object' || codegen === null || Array.isArray(codegen)) {
      throw new Error('Config codegen must be an object');
    }
    if (
      codegen.rustManifest !== undefined &&
      (typeof codegen.rustManifest !== 'string' ||
        codegen.rustManifest.length === 0 ||
        /[\0\r\n]/.test(codegen.rustManifest))
    ) {
      throw new Error('Config codegen.rustManifest must be a non-empty safe path');
    }
    for (const field of ['rustPackage', 'rustBinary'] as const) {
      const value = codegen[field];
      if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value))) {
        throw new Error(`Config codegen.${field} must be a Cargo identifier`);
      }
    }
  }
  const rn = config.reactNative;
  if (rn !== undefined) {
    assertKnownKeys(rn, REACT_NATIVE_CONFIG_KEYS, 'config reactNative');
    if (typeof rn !== 'object' || rn === null || Array.isArray(rn)) {
      throw new Error('Config reactNative must be an object');
    }
    if ('nativeModule' in rn) {
      throw new Error(
        'Config reactNative.nativeModule was removed. Use the generated @rustra/generated-react-native module.',
      );
    }
    if (
      rn.rustPackage !== undefined &&
      (typeof rn.rustPackage !== 'string' || !/^[A-Za-z0-9_-]+$/.test(rn.rustPackage))
    ) {
      throw new Error('Config reactNative.rustPackage must be a Cargo package name');
    }
    if (
      rn.rustLibrary !== undefined &&
      (typeof rn.rustLibrary !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(rn.rustLibrary))
    ) {
      throw new Error('Config reactNative.rustLibrary must be a static-library identifier');
    }
    for (const [key, path] of [
      ['moduleDir', rn.moduleDir],
      ['rustManifest', rn.rustManifest],
    ] as const) {
      if (
        path !== undefined &&
        (typeof path !== 'string' || path.length === 0 || /[\0\r\n]/.test(path))
      ) {
        throw new Error(`Config reactNative.${key} must be a non-empty safe path`);
      }
    }
    if (rn.legacyBenchmarks !== undefined && typeof rn.legacyBenchmarks !== 'boolean') {
      throw new Error('Config reactNative.legacyBenchmarks must be a boolean');
    }
  }

  for (const [host, value] of [
    ['node', config.node],
    ['bun', config.bun],
    ['tauri', config.tauri],
  ] as const) {
    if (
      value !== undefined &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    ) {
      throw new Error(`Config ${host} must be an object`);
    }
  }
  if (config.node) assertKnownKeys(config.node, NODE_CONFIG_KEYS, 'config node');
  if (config.bun) assertKnownKeys(config.bun, BUN_CONFIG_KEYS, 'config bun');
  if (config.tauri) assertKnownKeys(config.tauri, [], 'config tauri');
  for (const [host, value] of [
    ['node', config.node],
    ['bun', config.bun],
  ] as const) {
    if (!value) continue;
    if (
      value.rustManifest !== undefined &&
      (typeof value.rustManifest !== 'string' ||
        value.rustManifest.length === 0 ||
        /[\0\r\n]/.test(value.rustManifest))
    ) {
      throw new Error(`Config ${host}.rustManifest must be a non-empty safe path`);
    }
    if (
      value.rustPackage !== undefined &&
      (typeof value.rustPackage !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.rustPackage))
    ) {
      throw new Error(`Config ${host}.rustPackage must be a Cargo package name`);
    }
  }
  if (
    config.node?.rustBinary !== undefined &&
    (typeof config.node.rustBinary !== 'string' || !/^[A-Za-z0-9_-]+$/.test(config.node.rustBinary))
  ) {
    throw new Error('Config node.rustBinary must be a Cargo binary name');
  }
  if (
    config.node?.args !== undefined &&
    (!Array.isArray(config.node.args) ||
      config.node.args.some(
        (arg) => typeof arg !== 'string' || arg.length === 0 || /[\0\r\n]/.test(arg),
      ))
  ) {
    throw new Error('Config node.args must be an array of non-empty safe strings');
  }
  if (
    config.bun?.rustLibrary !== undefined &&
    (typeof config.bun.rustLibrary !== 'string' ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.bun.rustLibrary))
  ) {
    throw new Error('Config bun.rustLibrary must be a cdylib identifier');
  }
  if (config.tauri && Object.keys(config.tauri).length > 0) {
    throw new Error('Config tauri currently accepts only an empty object');
  }
  assertDevSection(config.dev);
  assertInspectorSection(config.inspector);

  const semanticErrors = collectSemanticErrors(config);
  if (semanticErrors.length > 0) {
    const list = semanticErrors.map((message, index) => `  ${index + 1}. ${message}`).join('\n');
    throw new Error(
      `Config has ${semanticErrors.length} semantic error${semanticErrors.length === 1 ? '' : 's'}:\n${list}`,
    );
  }

  return config;
}

const BOOL_ERROR = 'must be a boolean';

/** L1 — dev 섹션: fail-closed 키 검사 + 리프 값 타입/허용값 검사. */
function assertDevSection(dev: DevConfig | undefined): void {
  if (dev === undefined) return;
  assertKnownKeys(dev, DEV_CONFIG_KEYS, 'config dev');
  if (dev.target !== undefined && !DEV_TARGETS.includes(dev.target)) {
    throw new Error(unknownValueError('dev.target', dev.target, [...DEV_TARGETS]));
  }
  const wasm = dev.wasm;
  if (wasm === undefined) return;
  assertKnownKeys(wasm, DEV_WASM_CONFIG_KEYS, 'config dev.wasm');
  if (wasm.parityGate !== undefined && typeof wasm.parityGate !== 'boolean') {
    throw new Error(`Config dev.wasm.parityGate ${BOOL_ERROR}`);
  }
}

/** L1 — inspector 섹션: fail-closed 키 검사 + onMismatch 허용값 검사. */
function assertInspectorSection(inspector: InspectorConfig | undefined): void {
  if (inspector === undefined) return;
  assertKnownKeys(inspector, INSPECTOR_CONFIG_KEYS, 'config inspector');
  if (inspector.onMismatch !== undefined && !ON_MISMATCH_VALUES.includes(inspector.onMismatch)) {
    throw new Error(
      unknownValueError('inspector.onMismatch', inspector.onMismatch, [...ON_MISMATCH_VALUES]),
    );
  }
}

/**
 * 허용값 벗어남 L1 에러 — nearest 후보 did-you-mean(hoge 처럼 거리가 먼 값은 생략)에
 * 더해 허용값 전체를 항상 나열해 2값 열거형에서도 수정명령이 한 줄로 끝나게 한다.
 */
function unknownValueError(field: string, value: string, allowed: readonly string[]): string {
  const suggestion = closestMatch(value, allowed);
  const hint = suggestion
    ? ` Did you mean "${suggestion}"? Allowed values: ${allowed.join(', ')}.`
    : ` Allowed values: ${allowed.join(', ')}.`;
  return `Unknown config ${field} value "${value}".${hint}`;
}

/**
 * L2 — 교차 필드 의미 검사. config 로드 경로에서 L1 통과 후 호출되며,
 * 위반을 하나도 놓치지 않고 전부 수집해 한 번에 나열한다(첫 위반에서 중단 않음).
 * 수집 순서는 고정 — reactNative 필요성, 잘못된 wasm 섹션 위치, parityGate, engine.
 * doctor 영역 환경 검사(devtools 설치 여부 등)는 여기 넣지 않는다 — 로드는 순수 함수.
 */
export function collectSemanticErrors(config: RustraConfig): string[] {
  const errors: string[] = [];
  const dev = config.dev;
  const target = dev?.target ?? 'native';

  if (target === 'wasm' && config.reactNative === undefined) {
    // wasm dev-target은 RN 어댑터의 staticlib 경로를 탄다 — RN 섹션이 필요하다.
    errors.push('dev.target "wasm" requires a reactNative section');
  }
  if (target !== 'wasm' && dev?.wasm !== undefined) {
    errors.push('dev.wasm is only valid when dev.target is "wasm"');
  }
  if (target !== 'wasm' && dev?.wasm?.parityGate !== undefined) {
    errors.push('dev.wasm.parityGate is only valid when dev.target is "wasm"');
  }
  if (dev?.wasm?.engine !== undefined && !WASM_ENGINES.includes(dev.wasm.engine)) {
    // engine 미지 값이 L2 수집인 이유 — reactNative 요구 위반과 동시에 발생할 수 있어
    // 전부 나열해야 한다. 반면 dev.target/onMismatch 는 섹션 자체의 유효성이라 L1 fail-fast.
    // (신규 엔진 편성 시 WASM_ENGINES 만 갱신하면 타입·검증·메시지가 함께 따라간다.)
    // 문구는 L1 unknownValueError 와 동일하게 — did-you-mean + 허용값 표시를 통일한다.
    errors.push(unknownValueError('dev.wasm.engine', dev.wasm.engine, [...WASM_ENGINES]));
  }

  return errors;
}

function assertKnownKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  // O(1) 조회 — allowed 배열을 루프 안에서 includes 로 훑지 않는다.
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      const suggestion = closestKey(key, allowed);
      const hint = suggestion
        ? ` Did you mean "${suggestion}"?`
        : ` Known keys: ${allowed.join(', ')}.`;
      throw new Error(`Unknown ${label} key "${key}".${hint}`);
    }
  }
}

/** config 키 제안 — 키 비교만 소문자로 맞추는 기존 드리프트를 유지한다. */
function closestKey(input: string, allowed: readonly string[]): string | undefined {
  return closestMatch(
    input.toLowerCase(),
    allowed.map((key) => key.toLowerCase()),
  );
}
