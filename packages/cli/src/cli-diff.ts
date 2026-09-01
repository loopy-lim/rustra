import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { diffSchemas, formatDiffResult } from './schema-diff.js';
import { parsePackageSchema } from './schema-validation.js';
import { cliFormat, parseCliArgs } from './cli-arg-parser.js';
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
    throw new Error('Provide --old and --new. Usage: rustra diff --old v1.json --new v2.json');
  const [oldRaw, newRaw] = await Promise.all([
    readFile(resolve(oldPath), 'utf-8'),
    readFile(resolve(newPath), 'utf-8'),
  ]);
  const result = diffSchemas(
    parsePackageSchema(JSON.parse(oldRaw)),
    parsePackageSchema(JSON.parse(newRaw)),
  );
  // --format json 은 doctor 와 같은 schemaVersion: 1 보고를 내보낸다 — breaking
  // 배열은 DiffResult.breaking 그대로(event_removed / event_payload_changed
  // fold 구조 보존). exit 코드 계약은 출력 형식과 무관하게 불변이다.
  if (cliFormat(options.values.get('format'), 'diff') === 'json')
    console.log(formatDiffJson(result));
  else console.log(formatDiffResult(result));
  if (result.breaking.length > 0) process.exitCode = 1;
}
