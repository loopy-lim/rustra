import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { diffSchemas, formatDiffResult } from './schema-diff.js';
import { parsePackageSchema } from './schema-validation.js';
import { cliFormat, parseCliArgs } from './cli-arg-parser.js';

export async function runDiff(args: string[]): Promise<void> {
  const options = parseCliArgs(args, {
    command: 'diff',
    valueFlags: ['old', 'new', 'format'],
    booleanFlags: ['help', 'h'],
  });
  if (options.flags.has('help') || options.flags.has('h')) return;
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
  if (cliFormat(options.values.get('format'), 'diff') === 'json')
    console.log(JSON.stringify(result, null, 2));
  else console.log(formatDiffResult(result));
  if (result.breaking.length > 0) process.exitCode = 1;
}
