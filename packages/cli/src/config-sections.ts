// rustra.json 검증의 L1 공용 프리미티브 — fail-closed 키 검사, 섹션별 리프 값
// 검사(dev/inspector/uniffi), 허용값 벗어남 메시지 생성. readConfigSync(config.ts)의
// L1 진입에서 호출되고, L2 수집(config-semantic.ts)은 unknownValueError 만 재사용한다.
import { closestMatch } from './cli-suggest.js';
import {
  DEV_CONFIG_KEYS,
  DEV_DYLIB_CONFIG_KEYS,
  DEV_TARGETS,
  DEV_WASM_CONFIG_KEYS,
  DYLIB_PROFILES,
  INSPECTOR_CONFIG_KEYS,
  ON_MISMATCH_VALUES,
  UNIFFI_CONFIG_KEYS,
  type DevConfig,
  type InspectorConfig,
  type RustraUniffiConfig,
} from './config-schema.js';

const BOOL_ERROR = 'must be a boolean';

/** L1 — dev 섹션: fail-closed 키 검사 + 리프 값 타입/허용값 검사. */
export function assertDevSection(dev: DevConfig | undefined): void {
  if (dev === undefined) return;
  assertKnownKeys(dev, DEV_CONFIG_KEYS, 'config dev');
  if (dev.target !== undefined && !DEV_TARGETS.includes(dev.target)) {
    throw new Error(unknownValueError('dev.target', dev.target, [...DEV_TARGETS]));
  }
  const wasm = dev.wasm;
  if (wasm !== undefined) {
    assertKnownKeys(wasm, DEV_WASM_CONFIG_KEYS, 'config dev.wasm');
    if (wasm.parityGate !== undefined && typeof wasm.parityGate !== 'boolean') {
      throw new Error(`Config dev.wasm.parityGate ${BOOL_ERROR}`);
    }
  }
  const dylib = dev.dylib;
  if (dylib !== undefined) {
    assertKnownKeys(dylib, DEV_DYLIB_CONFIG_KEYS, 'config dev.dylib');
    if (dylib.parityGate !== undefined && typeof dylib.parityGate !== 'boolean') {
      throw new Error(`Config dev.dylib.parityGate ${BOOL_ERROR}`);
    }
  }
}

/** L1 — inspector 섹션: fail-closed 키 검사 + onMismatch 허용값 검사. */
export function assertInspectorSection(inspector: InspectorConfig | undefined): void {
  if (inspector === undefined) return;
  assertKnownKeys(inspector, INSPECTOR_CONFIG_KEYS, 'config inspector');
  if (inspector.onMismatch !== undefined && !ON_MISMATCH_VALUES.includes(inspector.onMismatch)) {
    throw new Error(
      unknownValueError('inspector.onMismatch', inspector.onMismatch, [...ON_MISMATCH_VALUES]),
    );
  }
}

/**
 * L1 — uniffi 섹션: fail-closed 키 검사 + 리프 값 타입/허용값 검사. output 은
 * 필수(schema/output 과 같은 비어있지 않은 안전 경로 계약)이고, srcOut/dylibProfile
 * 은 선택 — 기본값은 소비자(cli-codegen)가 채운다.
 */
export function assertUniffiSection(uniffi: RustraUniffiConfig | undefined): void {
  if (uniffi === undefined) return;
  assertKnownKeys(uniffi, UNIFFI_CONFIG_KEYS, 'config uniffi');
  if (
    typeof uniffi.output !== 'string' ||
    uniffi.output.length === 0 ||
    /[\0\r\n]/.test(uniffi.output)
  ) {
    throw new Error('Config uniffi.output must be a non-empty safe path');
  }
  if (
    uniffi.srcOut !== undefined &&
    (typeof uniffi.srcOut !== 'string' ||
      uniffi.srcOut.length === 0 ||
      /[\0\r\n]/.test(uniffi.srcOut))
  ) {
    throw new Error('Config uniffi.srcOut must be a non-empty safe path');
  }
  if (uniffi.dylibProfile !== undefined && !DYLIB_PROFILES.includes(uniffi.dylibProfile)) {
    throw new Error(
      unknownValueError('uniffi.dylibProfile', uniffi.dylibProfile, [...DYLIB_PROFILES]),
    );
  }
}

/**
 * 허용값 벗어남 L1 에러 — nearest 후보 did-you-mean(hoge 처럼 거리가 먼 값은 생략)에
 * 더해 허용값 전체를 항상 나열해 2값 열거형에서도 수정명령이 한 줄로 끝나게 한다.
 */
export function unknownValueError(
  field: string,
  value: string,
  allowed: readonly string[],
): string {
  const suggestion = closestMatch(value, allowed);
  const hint = suggestion
    ? ` Did you mean "${suggestion}"? Allowed values: ${allowed.join(', ')}.`
    : ` Allowed values: ${allowed.join(', ')}.`;
  return `Unknown config ${field} value "${value}".${hint}`;
}

export function assertKnownKeys(value: unknown, allowed: readonly string[], label: string): void {
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
