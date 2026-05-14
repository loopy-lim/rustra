/**
 * @rustra/cli — TypeScript 코드 생성기
 *
 * rustra 패키지 스키마에서 TypeScript 타입 정의, 명령 헬퍼 함수,
 * 계약 해시 파일을 생성합니다.
 *
 * @example
 * ```ts
 * import { generateTypesTs, generateCommandsTs, generateContractTs } from '@rustra/cli';
 * import type { PackageSchema } from '@rustra/cli/schema';
 *
 * const schema: PackageSchema = JSON.parse(readFileSync('generated/schema.json', 'utf-8'));
 * writeFileSync('generated/types.ts', generateTypesTs(schema));
 * writeFileSync('generated/commands.ts', generateCommandsTs(schema));
 * writeFileSync('generated/contract.ts', generateContractTs(JSON.stringify(schema)));
 * ```
 */

import { createHash } from "node:crypto";
import type { CommandSchema, JsonSchema, PackageSchema } from "./schema.js";

/**
 * 패키지 스키마에서 TypeScript 타입 정의 파일(`types.ts`)을 생성합니다.
 *
 * `@rustra/types`에서 `EngineClient`, `RustraError`, `RustraCommandError`를
 * re-export하고, 모든 명령의 입출력 타입을 `export type`으로 생성합니다.
 *
 * @param schema - 패키지 스키마
 * @returns 생성된 TypeScript 타입 정의 코드
 *
 * @example
 * ```ts
 * const typesCode = generateTypesTs(schema);
 * // 출력:
 * // export type { EngineClient, RustraError } from '@rustra/types';
 * // export { RustraCommandError } from '@rustra/types';
 * //
 * // export type AddNumbersInput = { a: number; b: number; };
 * // export type AddNumbersOutput = { value: number; };
 * // ```
 */
export function generateTypesTs(schema: PackageSchema): string {
  let output =
    "export type { EngineClient, RustraError } from '@rustra/types';\n" +
    "export { RustraCommandError } from '@rustra/types';\n\n";

  const allDefinitions: Record<string, JsonSchema> = {};
  for (const command of schema.commands) {
    collectDefinitions(command.inputSchema, allDefinitions);
    collectDefinitions(command.outputSchema, allDefinitions);
  }

  const emitted = new Set<string>();

  for (const [name, defSchema] of Object.entries(allDefinitions)) {
    if (emitted.has(name)) continue;
    emitted.add(name);
    output += `export type ${name} = ${tsTypeFromSchema(defSchema, allDefinitions)};\n\n`;
  }

  for (const command of schema.commands) {
    if (!emitted.has(command.inputType)) {
      emitted.add(command.inputType);
      output += `export type ${command.inputType} = ${tsTypeFromSchema(command.inputSchema, allDefinitions)};\n\n`;
    }
    if (!emitted.has(command.outputType)) {
      emitted.add(command.outputType);
      output += `export type ${command.outputType} = ${tsTypeFromSchema(command.outputSchema, allDefinitions)};\n\n`;
    }
  }

  return output;
}

/**
 * 패키지 스키마에서 TypeScript 명령 헬퍼 함수 파일(`commands.ts`)을 생성합니다.
 *
 * 각 명령에 대해 `engine.invoke()`를 래핑하는 함수를 생성합니다.
 *
 * @param schema - 패키지 스키마
 * @returns 생성된 TypeScript 명령 헬퍼 함수 코드
 *
 * @example
 * ```ts
 * const commandsCode = generateCommandsTs(schema);
 * // 출력:
 * // import type { AddNumbersInput, AddNumbersOutput, EngineClient } from './types.js';
 * //
 * // export function addNumbers(engine: EngineClient, input: AddNumbersInput): Promise<AddNumbersOutput> {
 * //   return engine.invoke<AddNumbersOutput>('addNumbers', input);
 * // }
 * // ```
 */
export function generateCommandsTs(schema: PackageSchema): string {
  const typeNames = new Set(["EngineClient"]);
  for (const command of schema.commands) {
    typeNames.add(command.inputType);
    typeNames.add(command.outputType);
  }

  const imports = Array.from(typeNames).sort().join(", ");
  let output = `import type { ${imports} } from './types.js';\n\n`;

  for (const command of schema.commands) {
    const fnName = commandFunctionName(command.name);
    output +=
      `export function ${fnName}(engine: EngineClient, input: ${command.inputType}): Promise<${command.outputType}> {\n` +
      `  return engine.invoke<${command.outputType}>('${command.name}', input);\n` +
      `}\n\n`;
  }

  return output;
}

/**
 * 스키마 JSON에서 계약 해시 파일(`contract.ts`)을 생성합니다.
 *
 * 스키마의 SHA-256 해시를 `GENERATED_CONTRACT_HASH` 상수로 export합니다.
 * 런타임에 이 해시를 비교하여 생성된 코드와 스키마가 일치하는지 검증할 수 있습니다.
 *
 * @param schemaJson - JSON으로 직렬화된 패키지 스키마 문자열
 * @returns `export const GENERATED_CONTRACT_HASH = '...';` 형태의 코드
 *
 * @example
 * ```ts
 * const contractCode = generateContractTs(schemaJson);
 * // 출력: export const GENERATED_CONTRACT_HASH = 'a1b2c3d4...';
 * // ```
 */
export function generateContractTs(schemaJson: string): string {
  const hash = contractHash(schemaJson);
  return `export const GENERATED_CONTRACT_HASH = '${hash}';\n`;
}

/** SHA-256 해시를 hex 문자열로 반환합니다. */
function contractHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 스키마에서 `definitions` 객체를 추출하여 `out`에 병합합니다.
 *
 * 여러 명령의 스키마에서 공유 타입 정의를 하나로 모읍니다.
 */
function collectDefinitions(
  schema: JsonSchema,
  out: Record<string, JsonSchema>,
): void {
  if (schema.definitions) {
    for (const [key, value] of Object.entries(schema.definitions)) {
      out[key] = value;
    }
  }
}

/**
 * JSON Schema를 TypeScript 타입 표현식 문자열로 변환합니다.
 *
 * `$ref`, `anyOf`, `object`, `array`, 원시 타입 등을 재귀적으로 처리합니다.
 *
 * @param schema - 변환할 JSON Schema
 * @param definitions - `$ref` 해결에 사용할 타입 정의 맵
 * @returns TypeScript 타입 표현식 문자열
 */
function tsTypeFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  if (schema.$ref) {
    return resolveRef(schema.$ref, definitions);
  }

  if (schema.anyOf) {
    return schema.anyOf
      .map((s) => tsTypeFromSchema(s, definitions))
      .join(" | ");
  }

  const type = schema.type;

  if (typeof type === "string") {
    switch (type) {
      case "object":
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

/** `$ref` 문자열에서 타입 이름을 추출합니다. `#/definitions/Foo` → `Foo` */
function resolveRef(
  ref: string,
  _definitions: Record<string, JsonSchema>,
): string {
  const name =
    ref.startsWith("#/definitions/")
      ? ref.slice("#/definitions/".length)
      : ref.startsWith("#/$defs/")
        ? ref.slice("#/$defs/".length)
        : ref;
  return name;
}

/**
 * JSON Schema object를 TypeScript 객체 타입 리터럴로 변환합니다.
 *
 * `properties`의 각 필드를 `name: type;` 형식으로 생성하며,
 * `required`에 없는 필드는 `?` 선택적 필드로 표시합니다.
 */
function tsObjectFromSchema(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  const required = new Set(schema.required ?? []);
  const properties = schema.properties;

  if (!properties) {
    return "Record<string, unknown>";
  }

  const fields = Object.entries(properties)
    .map(([name, propSchema]) => {
      const optional = required.has(name) ? "" : "?";
      return `  ${name}${optional}: ${tsTypeFromSchema(propSchema, definitions)};`;
    })
    .join("\n");

  return `{\n${fields}\n}`;
}

/** 명령 이름을 lowerCamelCase TypeScript 함수 이름으로 변환합니다. */
function commandFunctionName(name: string): string {
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

/** 문자가 ASCII 영숫자인지 확인합니다. */
function isAsciiAlphanumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}
