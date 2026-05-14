/**
 * TypeScript 코드 생성 유틸리티입니다.
 *
 * JSON Schema를 TypeScript 타입 표현식으로 변환하고
 * 명령 이름을 lowerCamelCase 함수 이름으로 변환합니다.
 */

import type { JsonSchema } from "./schema.js";

/** `$ref` 문자열에서 타입 이름을 추출합니다. `#/definitions/Foo` → `Foo` */
export function resolveRef(ref: string): string {
  if (ref.startsWith("#/definitions/")) return ref.slice("#/definitions/".length);
  if (ref.startsWith("#/$defs/")) return ref.slice("#/$defs/".length);
  return ref;
}

/**
 * JSON Schema를 TypeScript 타입 표현식 문자열로 변환합니다.
 *
 * `$ref`, `anyOf`, `object`, `array`, 원시 타입 등을 재귀적으로 처리합니다.
 */
export function tsTypeFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  if (schema.$ref) return resolveRef(schema.$ref);

  if (schema.anyOf) {
    return schema.anyOf.map((s) => tsTypeFromSchema(s, definitions)).join(" | ");
  }

  const type = schema.type;

  if (typeof type === "string") {
    switch (type) {
      case "object":
        if (!schema.properties && schema.additionalProperties) {
          const valueType = tsTypeFromSchema(schema.additionalProperties, definitions);
          return `Record<string, ${valueType}>`;
        }
        return tsObjectFromSchema(schema, definitions);
      case "integer":
      case "number":
        return "number";
      case "string": {
        if (schema.enum && schema.enum.length > 0) {
          return schema.enum.map((v) => `'${v}'`).join(" | ");
        }
        return "string";
      }
      case "boolean":
        return "boolean";
      case "array": {
        const itemType = schema.items
          ? tsTypeFromSchema(schema.items, definitions)
          : "unknown";
        return `${itemType}[]`;
      }
      case "null":
        return "null";
      default:
        return "unknown";
    }
  }

  if (Array.isArray(type)) {
    const parts = type
      .map((t) => {
        switch (t) {
          case "integer":
          case "number":
            return "number";
          case "string":
            return "string";
          case "boolean":
            return "boolean";
          case "null":
            return "null";
          case "object":
            return tsObjectFromSchema(schema, definitions);
          case "array":
            return schema.items
              ? `${tsTypeFromSchema(schema.items, definitions)}[]`
              : "unknown[]";
          default:
            return "unknown";
        }
      })
      .filter((v, i, a) => a.indexOf(v) === i);
    return parts.join(" | ");
  }

  return "unknown";
}

/**
 * JSON Schema object를 TypeScript 객체 타입 리터럴로 변환합니다.
 *
 * `properties`의 각 필드를 `name: type;` 형식으로 생성하며,
 * `required`에 없는 필드는 `?` 선택적 필드로 표시합니다.
 */
export function tsObjectFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  const required = new Set(schema.required ?? []);
  const properties = schema.properties;

  if (!properties) return "Record<string, unknown>";

  const fields = Object.entries(properties)
    .map(([name, propSchema]) => {
      const optional = required.has(name) ? "" : "?";
      return `  ${name}${optional}: ${tsTypeFromSchema(propSchema, definitions)};`;
    })
    .join("\n");

  return `{\n${fields}\n}`;
}

/**
 * 스키마에서 `definitions` 객체를 추출하여 `out`에 병합합니다.
 */
export function collectDefinitions(
  schema: JsonSchema,
  out: Record<string, JsonSchema>,
): void {
  if (schema.definitions) {
    for (const [key, value] of Object.entries(schema.definitions)) {
      out[key] = value;
    }
  }
}

/** 명령 이름을 lowerCamelCase TypeScript 함수 이름으로 변환합니다. */
export function commandFunctionName(name: string): string {
  let output = "";
  let uppercaseNext = false;

  for (const char of name) {
    if (isAsciiAlphanumeric(char)) {
      if (output.length === 0) {
        output += char.toLowerCase();
      } else if (uppercaseNext) {
        output += char.toUpperCase();
        uppercaseNext = false;
      } else {
        output += char;
      }
    } else {
      uppercaseNext = true;
    }
  }

  return output.length > 0 ? output : "command";
}

function isAsciiAlphanumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}
