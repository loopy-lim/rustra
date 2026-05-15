/**
 * @rustra/cli — TypeScript 코드 생성기
 *
 * rustra 패키지 스키마에서 TypeScript 타입 정의, 명령 헬퍼 함수,
 * 계약 해시 파일을 생성합니다.
 */

import { createHash } from 'node:crypto';
import type { CommandSchema, PackageSchema } from './schema.js';
import { collectDefinitions, commandFunctionName, tsTypeFromSchema } from './codegen.js';

/**
 * 패키지 스키마에서 TypeScript 타입 정의 파일(`types.ts`)을 생성합니다.
 */
export function generateTypesTs(schema: PackageSchema): string {
  let output =
    "export type { EngineClient, RustraError } from '@rustra/types';\n" +
    "export { RustraCommandError } from '@rustra/types';\n\n";

  const allDefinitions: Record<string, import('./schema.js').JsonSchema> = {};
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
 */
export function generateCommandsTs(schema: PackageSchema): string {
  const typeNames = new Set(['EngineClient', 'RustraError']);
  for (const command of schema.commands) {
    typeNames.add(command.inputType);
    typeNames.add(command.outputType);
  }

  const imports = Array.from(typeNames).sort().join(', ');
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
 */
export function generateContractTs(schemaJson: string): string {
  const hash = createHash('sha256').update(schemaJson).digest('hex');
  return `export const GENERATED_CONTRACT_HASH = '${hash}';\n`;
}
