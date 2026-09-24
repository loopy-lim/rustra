import { validateFunctionArgs } from './function-schema.js';
import type { CommandSchema, JsonSchema, PackageSchema } from './schema.js';
import { commandFunctionName, collectDefinitions, isRustInternalTypeName } from './codegen.js';
import { setCodegenContext } from './codegen-warnings.js';
import { finishGeneratedText, generatedJsDoc } from './generate-surface.js';
import { collectAllDefinitions } from './generate-postcard-ir.js';
import { bufferCommandField, generatedFieldRoute } from './generate-routing.js';
import { tsTypeFromSchema } from './codegen-schema.js';
import { collectRefTypeNames } from './codegen-definitions.js';

/**
 * (M7) 생성 표면의 `InvokeOptions` 재노출에 붙는 취소 의미론 경고.
 *
 * 근거(docs/compatibility-matrix.md "Signal semantics in detail"): 얕은 취소
 * 어댑터에서 `signal` 은 JS 프라미스만 거부하고 Rust 실행은 계속되며,
 * `retryable: true`(`transport.timeout`·`cancelled`·`transport.error`)는
 * "재시도하면 실패 유형이 사라질 수 있음"이지 "재실행 안전"이 아니다. 이 경고가
 * 코어 타입 주석(@rustra/types public.ts)과 매트릭스 산문에만 있으면 생성
 * 파일만 열어보는 소비자에게 닿지 않으므로(DX_AUDIT M7) commands.ts 툴팁에
 * 그대로 삽입한다.
 */
const INVOKE_OPTIONS_JS_DOC = `/**
 * 이 패키지 생성 명령의 호출 옵션 — 모든 생성 함수의 마지막 파라미터.
 *
 * ⚠️ **얕은 취소**: \`signal\` 이 실행 중에 abort 되면 **JS 프라미스만 거부되고**
 * (shallow cancellation) Rust 명령은 끝까지 실행되거나 이미 완료됐을 수 있습니다.
 * 취소/타임아웃은 "명령이 실행되지 않았음"을 보장하지 않습니다.
 *
 * ⚠️ **\`retryable: true\` ≠ 재실행 안전**: \`transport.timeout\`·\`cancelled\` 등
 * retryable 오류는 재시도 시 실패 유형이 사라질 수 있음을 뜻할 뿐, 명령을 다시
 * 실행해도 안전하다는 뜻이 아닙니다. 비멱등 명령의 재시도는 상태를 재조회해 이전
 * 시도가 반영되지 않았음을 확인한 뒤에만 하세요.
 *
 * 전체 의미론은 docs/compatibility-matrix.md "Signal semantics in detail" 및
 * 원본 타입(\`InvokeOptions\`(@rustra/types)) 문서를 참고하세요.
 */
`;

/**
 * (S1) 호출 규약 혼재 알림 — struct 기반 명령과 positional 함수가 같은 패키지에
 * 존재할 때 commands.ts 상단에 붙는다. 소비자가 명령마다 호출 스타일을 추측하는
 * 대신 이 한 줄로 두 규약의 존재를 알게 한다(DX_AUDIT S1).
 */
const MIXED_CONVENTION_NOTE = `// ── 호출 규약 알림 ──────────────────────────────────────────────────
// 이 패키지는 두 호출 규약이 혼재합니다 — 시그니처로 구분하세요:
//   - positional 함수(PackageBuilder::function): 인자를 그대로 나열 — add(1, 2)
//   - struct 기반 명령(#[command]): 필드 객체 하나 — addNumbers({ a: 1, b: 2 })
// ───────────────────────────────────────────────────────────────────
`;

/**
 * (S1) 명령 루트 타입의 TS 표면 표현 — Rust 내부명(String·Tuple_of_… 등) 누출을
 * 스키마에서 직접 렌더링한 인라인 타입으로 정화한다. positional 명령의 파라미터는
 * 튜플 원소를 인라인로(`[string]` → `string`) 풀고, 그 외 명령도 입력/출력이
 * 내부명이면 인라인 표현을 쓴다. 레거시 이름은 types.ts 의 deprecated alias 로
 * 하위 호환이 유지된다.
 */
function surfaceTypeExpr(
  typeName: string,
  schema: JsonSchema,
  definitions: Record<string, JsonSchema>,
): string {
  if (!isRustInternalTypeName(typeName)) return typeName;
  return tsTypeFromSchema(schema, definitions);
}

/**
 * 패키지 스키마에서 TypeScript 명령 헬퍼 함수 파일(`commands.ts`)을 생성합니다.
 *
 * Tauri-like 글로벌 invoke 패턴: `configure()`로 엔진을 한 번 설정하면
 * 이후 `addNumbers({ a: 42 })`로 engine 파라미터 없이 호출 가능합니다.
 */
export function generateCommandsTs(schema: PackageSchema): string {
  const definitions = collectAllDefinitions(schema);
  // 인라인 렌더링은 types.ts 와 동일한 정의 수집(중첩 definitions 재귀 포함)로
  // refs 를 푼다 — alias 본문과 인라인 표현이 같은 맵을 보게 하여 정합시킨다.
  const typeDefinitions: Record<string, JsonSchema> = {};
  for (const command of schema.commands) {
    if (command.definitions) {
      for (const [key, value] of Object.entries(command.definitions)) {
        typeDefinitions[key] = value;
      }
    }
    collectDefinitions(command.inputSchema, typeDefinitions);
    collectDefinitions(command.outputSchema, typeDefinitions);
  }

  const typeNames = new Set<string>();
  const addCommandTypeRefs = (command: CommandSchema, kind: 'input' | 'output'): void => {
    const typeName = kind === 'input' ? command.inputType : command.outputType;
    const typeSchema = kind === 'input' ? command.inputSchema : command.outputSchema;
    if (typeName === '()') return;
    if (!isRustInternalTypeName(typeName)) {
      typeNames.add(typeName);
      return;
    }
    // 정화된 인라인 표현이 $ref 로 참조하는 정의(예: 튜플 원소 User)는
    // types.ts 에서 import 해야 시그니처가 성립한다.
    collectRefTypeNames(typeSchema, typeNames);
  };
  for (const command of schema.commands) {
    addCommandTypeRefs(command, 'input');
    addCommandTypeRefs(command, 'output');
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
  // (M7) InvokeOptions 를 문서화된 별칭으로 재노출한다 — 생성 파일의 툴팁에서
  // 얕은 취소·retryable 경고가 바로 보인다. 원본 계약은 @rustra/types 그대로다.
  output += `import type { InvokeOptions as CoreInvokeOptions } from '@rustra/types';\n\n`;
  output += INVOKE_OPTIONS_JS_DOC;
  output += `export type InvokeOptions = CoreInvokeOptions;\n\n`;

  // (S1) 규약 혼재 알림 — 두 규약이 함께 있을 때만 상단에 경고 주석을 붙인다.
  const hasPositional = schema.commands.some((command) => command.functionArgs !== undefined);
  const hasStructural = schema.commands.some((command) => command.functionArgs === undefined);
  if (hasPositional && hasStructural) output += MIXED_CONVENTION_NOTE + '\n';

  for (const command of schema.commands) {
    validateFunctionArgs(command);
    const fnName = commandFunctionName(command.name);
    // unit 출력 `()` → Promise<void>.
    const outType =
      command.outputType === '()'
        ? 'void'
        : surfaceTypeExpr(command.outputType, command.outputSchema, typeDefinitions);
    setCodegenContext(command.name);
    if (typeof command.description === 'string') {
      output += generatedJsDoc(command.description);
    } else if (typeof command.inputSchema?.description === 'string') {
      output += generatedJsDoc(command.inputSchema.description);
    }
    if (command.functionArgs !== undefined) {
      const args = Array.from({ length: command.functionArgs }, (_, i) => `arg${i}`);
      // (S1) positional 파라미터는 튜플 타입을 인라인로 푼다 — validateFunctionArgs
      // 가 items 배열(길이 = arity)을 보장하므로 원소 스키마에서 직접 렌더링한다
      // (`Tuple_of_String[0]` 대신 `string`).
      const items = command.inputSchema.items;
      const params = args.map(
        (arg, i) =>
          `${arg}: ${
            Array.isArray(items) && items[i]
              ? tsTypeFromSchema(items[i]!, typeDefinitions)
              : 'unknown'
          }`,
      );
      const payload = args.length ? `[${args.join(', ')}]` : 'null';
      const normalize = outType === 'void' ? '.then(() => undefined)' : '';
      output +=
        `export function ${fnName}(${[...params, 'options?: InvokeOptions'].join(', ')}): Promise<${outType}> {\n` +
        `  return invokeGenerated<${outType}>(${command.commandId}, '${command.name}', ${payload}, options)${normalize};\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
      continue;
    }
    if (command.inputType === '()') {
      output +=
        `export function ${fnName}(options?: InvokeOptions): Promise<${outType}> {\n` +
        `  return invokeGenerated<${outType}>(${command.commandId}, '${command.name}', undefined, options);\n` +
        `}\n${fnName}.commandId = '${command.name}';\n\n`;
    } else {
      // (S1) struct 기반 명령도 입력 타입이 Rust 내부명(예: Vec_of_String)이면
      // 인라인 표현으로 정화한다.
      const inType = surfaceTypeExpr(command.inputType, command.inputSchema, typeDefinitions);
      const bufferField = bufferCommandField(command, definitions);
      if (bufferField) {
        output +=
          `export function ${fnName}(input: ${inType}, options?: InvokeOptions): Promise<${outType}> {\n` +
          `  return invokeGeneratedBytes<${outType}>(${command.commandId}, '${command.name}', input, input[${JSON.stringify(bufferField.name)}], options);\n` +
          `}\n${fnName}.commandId = '${command.name}';\n\n`;
        continue;
      }
      const fields = generatedFieldRoute(command, definitions);
      if (fields) {
        if (fields.length === 2) {
          const fieldKeys = fields.map((field) => JSON.stringify(field.name)).join(', ');
          output +=
            `export const ${fnName} = createGeneratedFields2<${inType}, ${outType}>` +
            `(${command.commandId}, '${command.name}', ${fieldKeys}, '${fnName}');\n\n`;
          continue;
        }
        const fieldArgs = fields.map((field) => `input[${JSON.stringify(field.name)}]`).join(', ');
        output +=
          `export function ${fnName}(input: ${inType}, options?: InvokeOptions): Promise<${outType}> {\n` +
          `  return invokeGeneratedFields${fields.length}<${outType}>(${command.commandId}, '${command.name}', input, ${fieldArgs}, options);\n` +
          `}\n${fnName}.commandId = '${command.name}';\n\n`;
        continue;
      }
      output +=
        `export function ${fnName}(input: ${inType}, options?: InvokeOptions): Promise<${outType}> {\n` +
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
