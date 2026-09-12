export type CliOutputFormat = 'text' | 'json';
import { existsSync } from 'node:fs';
import { cliFormat, parseCliArgs } from './cli-arg-parser.js';
import { UsageError } from './cli-usage-error.js';

export interface CodegenOptions {
  configPath?: string;
  check?: boolean;
  explain?: boolean;
  checkBindings?: boolean;
  format?: CliOutputFormat;
  help?: boolean;
}
export interface GenerateOptions {
  schemaPath?: string;
  outputPath?: string;
  configPath?: string;
  cppOutputPath?: string;
  positional?: boolean;
  check?: boolean;
  format?: CliOutputFormat;
  help?: boolean;
}

export function parseCodegenArgs(args: string[]): CodegenOptions {
  const parsed = parseCliArgs(args, {
    command: 'codegen',
    valueFlags: ['config', 'format'],
    booleanFlags: ['check', 'check-bindings', 'explain', 'help'],
  });
  const format = cliFormat(parsed.values.get('format'), 'codegen');
  const help = parsed.flags.has('help');
  const configPath = parsed.values.get('config');
  const options: CodegenOptions = {};
  if (configPath) options.configPath = configPath;
  if (parsed.flags.has('check')) options.check = true;
  if (parsed.flags.has('check-bindings')) {
    options.checkBindings = true;
    options.check = true;
  }
  if (parsed.flags.has('explain')) options.explain = true;
  if (format) options.format = format;
  if (help) options.help = true;
  // 커맨드 레벨 필수 인자 누락도 usage — 파서 레벨과 같은 exit-2 계약. 단 doctor
  // 관례와 대칭으로 ./rustra.json 이 있으면 기본 채택한다(감사 A10) — 무인자
  // `rustra codegen` 이 관례화된 파일명에서 동작해야 첫 사용 흐름이 짧아진다.
  if (!options.help && !options.configPath) {
    if (existsSync('rustra.json')) options.configPath = 'rustra.json';
    else throw new UsageError('codegen requires --config <path>');
  }
  return options;
}

export function parseGenerateArgs(args: string[]): GenerateOptions {
  const parsed = parseCliArgs(args, {
    command: 'generate',
    valueFlags: ['schema', 'output', 'cpp-output', 'config', 'format'],
    booleanFlags: ['positional', 'check', 'help'],
  });
  const format = cliFormat(parsed.values.get('format'), 'generate');
  const help = parsed.flags.has('help');
  const schema = parsed.values.get('schema');
  const output = parsed.values.get('output');
  const cppOutput = parsed.values.get('cpp-output');
  const configPath = parsed.values.get('config');
  const options: GenerateOptions = {};
  if (schema) options.schemaPath = schema;
  if (output) options.outputPath = output;
  if (cppOutput) options.cppOutputPath = cppOutput;
  if (configPath) options.configPath = configPath;
  if (parsed.flags.has('positional')) options.positional = true;
  if (parsed.flags.has('check')) options.check = true;
  if (format) options.format = format;
  if (help) options.help = true;
  return options;
}
