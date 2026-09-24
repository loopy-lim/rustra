import type { JsonSchema } from './schema.js';

export function collectDefinitions(schema: JsonSchema, out: Record<string, JsonSchema>): void {
  collectDefinitionsInner(schema, out, new Set());
}

function collectDefinitionsInner(
  schema: JsonSchema,
  out: Record<string, JsonSchema>,
  visited: Set<JsonSchema>,
): void {
  if (visited.has(schema)) return;
  visited.add(schema);
  for (const [key, value] of Object.entries(schema.definitions ?? {})) {
    if (!out[key]) out[key] = value;
    collectDefinitionsInner(value, out, visited);
  }
  const children = [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : []),
    ...(schema.prefixItems ?? []),
    ...Object.values(schema.properties ?? {}),
  ];
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
    children.push(schema.additionalProperties);
  for (const child of children) collectDefinitionsInner(child, out, visited);
}

export function commandFunctionName(name: string): string {
  let output = '';
  let uppercaseNext = false;
  for (const char of name) {
    if (isAsciiAlphanumeric(char)) {
      if (!output) output += char.toLowerCase();
      else if (uppercaseNext) {
        output += char.toUpperCase();
        uppercaseNext = false;
      } else output += char;
    } else uppercaseNext = true;
  }
  return output || 'command';
}

/**
 * 세그먼트 이름(`.`/`_` 등 비영숫자 구분)을 PascalCase 심볼로 바꾼다 —
 * 'math.divide_by_zero' → 'MathDivideByZero', 'divide' → 'Divide'.
 * `RustraErrorCode.TransportTimeout`('transport.timeout') 관례와 같은 매핑이며
 * 커맨드별 에러 코드 키/가드 심볼(errors.ts 코드젠)에 쓰인다.
 */
export function pascalCaseName(name: string): string {
  let output = '';
  let uppercaseNext = true;
  for (const char of name) {
    if (isAsciiAlphanumeric(char)) {
      output += uppercaseNext ? char.toUpperCase() : char;
      uppercaseNext = false;
    } else uppercaseNext = true;
  }
  return output;
}

function isAsciiAlphanumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

// ── (S1) Rust 내부 타입명 누출 정화 ──────────────────────────────────
//
// schemars(`JsonSchema::schema_name`)이 명령 루트 타입에 붙이는 이름 — 원시
// 스칼라(`String`, `int32`, `double` …)과 합성(`Tuple_of_int32_and_int32`,
// `Array_of_User` …) — 은 Rust 내부 명명 그대로 TS 표면으로 흘러나왔다
// (`export type String = string` 은 JS 내장 이름과 충돌 — DX_AUDIT S1).
// 아래 판정은 schemars 0.8 의 실제 명명 규칙(primitives.rs simple_impl!/
// unsigned_impl!, tuple.rs·sequences.rs·maps.rs 의 `X_of_…` 포맷)에서
// 역추출한 고정 집합이다. 사용자 구조체명(derive 가 만드는 CamelCase)과는
// 접두어/원시명 집합이 겹치지 않으므로 이름만으로 판정 가능하다.

/** schemars 가 원시 타입에 붙이는 스키마 이름(JSON format 이름 포함). */
const SCHEMARS_PRIMITIVE_NAMES: ReadonlySet<string> = new Set([
  'String',
  'Boolean',
  'Null',
  'Character',
  'int',
  'int8',
  'int16',
  'int32',
  'int64',
  'int128',
  'uint',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'uint128',
  'float',
  'double',
  'ipv4',
  'ipv6',
  'ip',
  'Uuid',
]);

/** schemars 합성 타입명 접두어 — `Vec<T>` 는 `Array_of_T`, `[T; N]` 은
 *  `Array_size_N_of_T` 로 명명된다. */
const SCHEMARS_COMPOSITION_PREFIXES = [
  'Tuple_of_',
  'Array_of_',
  'Array_size_',
  'Array_up_to_size_',
  'Set_of_',
  'Map_of_',
  'Nullable_',
  'Result_of_',
  'Bound_of_',
  'Range_of_',
  'Either_',
] as const;

/**
 * Rust(schemars) 내부 타입명 누출 여부 — 이 이름은 commands.ts 시그니처에서
 * 인라인 타입(`[string]`, `number` …)으로 정화해 렌더링하고, types.ts 에서는
 * 하위 호환 deprecated alias 로만 남는다.
 */
export function isRustInternalTypeName(name: string): boolean {
  if (SCHEMARS_PRIMITIVE_NAMES.has(name)) return true;
  return SCHEMARS_COMPOSITION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** JS 전역 내장 타입명과의 충돌 여부 — deprecated alias 경고 문구용. */
export function isJsBuiltinTypeName(name: string): boolean {
  return [
    'String',
    'Boolean',
    'Null',
    'Number',
    'Object',
    'Symbol',
    'BigInt',
    'Function',
    'Array',
    'Promise',
  ].includes(name);
}

/**
 * 스키마 트리에서 `$ref` 가 가리키는 정의 이름을 전부 모은다 — 인라인 렌더링이
 * 참조하는 정의(예: 튜플 원소 `User`)를 commands.ts 의 import 목록에 올리기
 * 위한 수집기. collectDefinitions 와 같은 순회 범위를 쓴다.
 */
export function collectRefTypeNames(schema: JsonSchema, out: Set<string>): void {
  if (schema.$ref) {
    out.add(schema.$ref.slice(schema.$ref.lastIndexOf('/') + 1));
    return;
  }
  const children = [
    ...(schema.allOf ?? []),
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(Array.isArray(schema.items) ? schema.items : schema.items ? [schema.items] : []),
    ...(schema.prefixItems ?? []),
    ...Object.values(schema.properties ?? {}),
  ];
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
    children.push(schema.additionalProperties);
  for (const child of children) collectRefTypeNames(child, out);
}
