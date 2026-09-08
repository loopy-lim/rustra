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
