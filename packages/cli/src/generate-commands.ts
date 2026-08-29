import type { PackageSchema } from './schema.js';
import { commandFunctionName } from './codegen.js';
import { finishGeneratedText, generatedJsDoc } from './generate-surface.js';
import { collectAllDefinitions } from './generate-postcard-ir.js';
import { bufferCommandField, generatedFieldRoute } from './generate-routing.js';

/**
 * 패키지 스키마에서 TypeScript 명령 헬퍼 함수 파일(`commands.ts`)을 생성합니다.
 *
 * Tauri-like 글로벌 invoke 패턴: `configure()`로 엔진을 한 번 설정하면
 * 이후 `addNumbers({ a: 42 })`로 engine 파라미터 없이 호출 가능합니다.
 */
export function generateCommandsTs(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  const typeNames = new Set<string>();
  for (const command of schema.commands) {
    if (command.inputType !== '()') typeNames.add(command.inputType);
    if (command.outputType !== '()') typeNames.add(command.outputType);
  }

  const imports = Array.from(typeNames).sort().join(', ');
  let output = '';
  if (imports.length > 0) {
    output += `import type { ${imports} } from './types.js';\n`;
  }
  const generatedHelpers = new Set<string>(['invokeGenerated']);
  for (const command of schema.commands) {
    if (bufferCommandField(command, definitions)) {
      generatedHelpers.add('invokeGeneratedBytes');
      continue;
    }
    const fields = generatedFieldRoute(command, definitions);
    if (fields) {
      generatedHelpers.add(
        fields.length === 2 ? 'createGeneratedFields2' : `invokeGeneratedFields${fields.length}`,
      );
    }
  }
  output += `import { ${[...generatedHelpers].sort().join(', ')} } from '@rustra/types';\n`;
  output += `import type { InvokeOptions } from '@rustra/types';\n\n`;

  for (const command of schema.commands) {
    const fnName = commandFunctionName(command.name);
    // unit 출력 `()` → Promise<void>.
    const outType = command.outputType === '()' ? 'void' : command.outputType;
    if (typeof command.description === 'string') {
      output += generatedJsDoc(command.description);
    } else if (typeof command.inputSchema?.description === 'string') {
      output += generatedJsDoc(command.inputSchema.description);
    }
    if (command.inputType === '()') {
      output +=
        `export function ${fnName}(options?: InvokeOptions): Promise<${outType}> {\n` +
        `  return invokeGenerated<${outType}>(${command.commandId}, '${command.name}', undefined, options);\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
    } else {
      const bufferField = bufferCommandField(command, definitions);
      if (bufferField) {
        output +=
          `export function ${fnName}(input: ${command.inputType}, options?: InvokeOptions): Promise<${outType}> {\n` +
          `  return invokeGeneratedBytes<${outType}>(${command.commandId}, '${command.name}', input, input[${JSON.stringify(bufferField.name)}], options);\n` +
          `}\n${fnName}.commandId = '${command.name}';\n\n`;
        continue;
      }
      const fields = generatedFieldRoute(command, definitions);
      if (fields) {
        if (fields.length === 2) {
          const fieldKeys = fields.map((field) => JSON.stringify(field.name)).join(', ');
          output +=
            `export const ${fnName} = createGeneratedFields2<${command.inputType}, ${outType}>` +
            `(${command.commandId}, '${command.name}', ${fieldKeys}, '${fnName}');\n\n`;
          continue;
        }
        const fieldArgs = fields.map((field) => `input[${JSON.stringify(field.name)}]`).join(', ');
        output +=
          `export function ${fnName}(input: ${command.inputType}, options?: InvokeOptions): Promise<${outType}> {\n` +
          `  return invokeGeneratedFields${fields.length}<${outType}>(${command.commandId}, '${command.name}', input, ${fieldArgs}, options);\n` +
          `}\n${fnName}.commandId = '${command.name}';\n\n`;
        continue;
      }
      output +=
        `export function ${fnName}(input: ${command.inputType}, options?: InvokeOptions): Promise<${outType}> {\n` +
        `  return invokeGenerated<${outType}>(${command.commandId}, '${command.name}', input, options);\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
    }
  }

  return finishGeneratedText(output);
}

/**
 * 스키마 JSON에서 계약 해시 파일(`contract.ts`)을 생성합니다.
 *
 * (T2, OTA) 스키마의 `schemaVersion` 을 `SCHEMA_VERSION` 상수로 함께 노출한다 —
 * Rust 코드젠(`GeneratedPackage::contract_ts`)과 동일한 형식이며, JS 클라이언트가
 * 네이티브 live schema 의 버전과 비교해 JS > native stale 를 감지하는 데 쓰인다.
 * 필드가 없는 구 스키마는 1 로 취급한다.
 */
