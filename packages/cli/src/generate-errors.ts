/**
 * @rustra/cli — 커맨드별 타입화 에러 렌더러
 *
 * 스키마 명령 항목의 `errors` 선언에서 `errors.ts`를 생성한다 — 커맨드별
 * 에러 코드 리터럴 유니언(`{Fn}ErrorCode`) + `RustraCommandError` 교차 타입
 * (`{Fn}Error`) + 타입 가드(`is{Fn}Error`). 런타임 에러 계약(와이어 프레임,
 * 호스트 승격, `RustraCommandError`)은 무변경 — 선언은 TS 표면만 좁힌다.
 *
 * 선언 커맨드가 1건이라도 있으면 파일 내용을, 없으면 빈 문자열을 반환한다
 * (events.ts 관례 — 선언 없는 패키지는 기존 출력과 바이트 동일).
 */
import type { CommandErrorVariantSchema, CommandSchema, PackageSchema } from './schema.js';
import { commandFunctionName, escapeJsDoc, pascalCaseName } from './codegen.js';
import { finishGeneratedText } from './generate-surface.js';

/** Rust 빌더와 TS 파서(parseRustraErrorString)가 공유하는 코드 토큰 집합. */
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.]*$/;

export function generateErrorsTs(schema: PackageSchema): string {
  const declared = schema.commands.filter((command) => (command.errors?.length ?? 0) > 0);
  if (declared.length === 0) return '';

  let output = "import { RustraCommandError } from '@rustra/types';\n";
  const symbols = new Set<string>();
  for (const command of declared) {
    output += `\n${renderCommandErrorSurface(command, symbols)}`;
  }
  return finishGeneratedText(output);
}

/** 커맨드 하나의 에러 표면 — 코드 집합, 코드 상수, 유니언/교차 타입, 가드. */
function renderCommandErrorSurface(command: CommandSchema, symbols: Set<string>): string {
  const fnName = commandFunctionName(command.name);
  const symbol = pascalCaseName(command.name);
  if (symbols.has(symbol)) {
    throw new Error(
      `Invalid schema: commands colliding on error symbol '${symbol}' ('${command.name}' declared twice?) — ` +
        `is${symbol}Error/${symbol}ErrorCode would be emitted more than once`,
    );
  }
  symbols.add(symbol);

  const entries: string[] = [];
  const codes: string[] = [];
  const keyOwners = new Map<string, string>();
  for (const variant of command.errors ?? []) {
    if (!ERROR_CODE_PATTERN.test(variant.code)) {
      throw new Error(
        `Invalid schema: command '${command.name}' declares invalid error code '${variant.code}' — ` +
          `must match ^[a-z][a-z0-9_.]*$ (same token set as the Rust builder)`,
      );
    }
    const key = pascalCaseName(variant.code);
    const owner = keyOwners.get(key);
    if (owner !== undefined) {
      // 정확 중복(같은 코드)은 무해하며 Rust 빌더가 이미 패닉 대상 — 키·코드가
      // 모두 같은 충돌만 여기서 막는다.
      if (owner !== variant.code) {
        throw new Error(
          `Invalid schema: command '${command.name}' declares '${owner}' and '${variant.code}' — ` +
            `both map to PascalCase key '${key}'; rename one of the codes`,
        );
      }
      continue;
    }
    keyOwners.set(key, variant.code);
    codes.push(variant.code);
    entries.push(variantEntry(key, variant));
  }

  const setCodes = codes.map((code) => `'${code}'`).join(', ');
  let output = '';
  output += `const ${fnName}ErrorCodes: ReadonlySet<string> = new Set([${setCodes}]);\n`;
  output += '\n';
  output += `/** ${command.name}가 반환할 수 있는 도메인 에러 코드 (Rust 선언 기준). */\n`;
  output += `export const ${symbol}ErrorCode = {\n${entries.join('\n')}\n} as const;\n`;
  output += `export type ${symbol}ErrorCode = (typeof ${symbol}ErrorCode)[keyof typeof ${symbol}ErrorCode];\n`;
  output += '\n';
  output += `/** code 리터럴로 좁혀진 ${command.name}의 에러 (discriminated by \`code\`). */\n`;
  output += `export type ${symbol}Error = RustraCommandError & { readonly code: ${symbol}ErrorCode };\n`;
  output += '\n';
  output += `/**\n`;
  output += ` * catch 분기용 타입 가드 — 미선언 코드(신규 네이티브 등)는 false.\n`;
  output += ` * 런타임은 개방 계약, 타입은 폐쇄 유니언 — 폴백은 err.code 문자열 분기.\n`;
  output += ` */\n`;
  output += `export function is${symbol}Error(error: unknown): error is ${symbol}Error {\n`;
  output += `  return error instanceof RustraCommandError && ${fnName}ErrorCodes.has(error.code);\n`;
  output += `}\n`;
  return output;
}

/** const object의 variant 엔트리 — description/retryable을 JSDoc으로 소개한다. */
function variantEntry(key: string, variant: CommandErrorVariantSchema): string {
  const retry = variant.retryable === true ? 'retryable' : 'non-retryable';
  const description =
    typeof variant.description === 'string'
      ? escapeJsDoc(variant.description.replace(/\s+/gu, ' ').trim())
      : '';
  const doc = description ? `${description} — ${retry}.` : `${retry}.`;
  return `  /** ${doc} */\n  ${key}: '${variant.code}',`;
}
