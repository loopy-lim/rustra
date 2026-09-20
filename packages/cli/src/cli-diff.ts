import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { diffSchemas, formatDiffResult } from './schema-diff.js';
import { parsePackageSchema } from './schema-validation.js';
import { cliFormat, parseCliArgs } from './cli-arg-parser.js';
import { UsageError } from './cli-usage-error.js';
import { formatDiffJson } from './cli-json-format.js';

export async function runDiff(args: string[]): Promise<void> {
  const options = parseCliArgs(args, {
    command: 'diff',
    valueFlags: ['old', 'new', 'format'],
    booleanFlags: ['help'],
  });
  // help 관례 — 파서는 플래그만 채우고 출력은 cli-main 이 담당한다.
  if (options.flags.has('help')) return;
  const oldPath = options.values.get('old');
  const newPath = options.values.get('new');
  if (!oldPath || !newPath)
    throw new UsageError('Provide --old and --new. Usage: rustra diff --old v1.json --new v2.json');
  // 파일 부재도 파싱 실패와 같은 계약 — 경로와 재생성 힌트를 붙인다(감사 A7
  // 후속). ENOENT 는 프로젝트 상태 오류로 exit 1, UsageError(exit 2)가 아니다.
  const readSchemaArg = async (path: string): Promise<string> => {
    try {
      return await readFile(resolve(path), 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        throw new Error(
          `Schema file not found: ${resolve(path)}. Pass existing schema files via --old/--new, ` +
            `or regenerate them with "cargo run" (the package's generate bin).`,
          { cause: error },
        );
      }
      throw error;
    }
  };
  const [oldRaw, newRaw] = await Promise.all([readSchemaArg(oldPath), readSchemaArg(newPath)]);
  // 입력 JSON 파싱 실패를 경로·재생성 힌트와 함께 래핑 — generate 경로
  // (cli-generate-files.ts)와 동일한 패턴. 무경로 JSON.parse 는 "어느 파일을
  // 고쳐야 하는지"를 알려주지 않는다(감사 A7).
  const parseSchemaFile = (raw: string, path: string): ReturnType<typeof parsePackageSchema> => {
    try {
      return parsePackageSchema(JSON.parse(raw));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Invalid schema.json at ${resolve(path)}: ${detail}. ` +
          `The file must be valid JSON; regenerate it with "cargo run" (the package's generate bin) ` +
          `or fix it manually.`,
        { cause: error },
      );
    }
  };
  const result = diffSchemas(parseSchemaFile(oldRaw, oldPath), parseSchemaFile(newRaw, newPath));
  // --format json 은 doctor 와 같은 schemaVersion: 1 보고를 내보낸다 — breaking
  // 배열은 DiffResult.breaking 그대로(event_removed / event_payload_changed
  // fold 구조 보존). exit 코드 계약은 출력 형식과 무관하게 불변이다.
  if (cliFormat(options.values.get('format'), 'diff') === 'json')
    console.log(formatDiffJson(result));
  else console.log(formatDiffResult(result));
  if (result.breaking.length > 0) process.exitCode = 1;
}
