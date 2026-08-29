export type CliOutputFormat = 'text' | 'json';
import { cliFormat, parseCliArgs } from './cli-arg-parser.js';

export interface CodegenOptions {
  configPath?: string;
  check?: boolean;
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
    booleanFlags: ['check', 'help', 'h'],
  });
  const format = cliFormat(parsed.values.get('format'), 'codegen');
  const help = parsed.flags.has('help') || parsed.flags.has('h');
  const options: CodegenOptions = {
    ...(parsed.values.get('config') ? { configPath: parsed.values.get('config') } : {}),
    ...(parsed.flags.has('check') ? { check: true } : {}),
    ...(format ? { format } : {}),
    ...(help ? { help: true } : {}),
  };
  if (!options.help && !options.configPath) throw new Error('codegen requires --config <path>');
  return options;
}

export function parseGenerateArgs(args: string[]): GenerateOptions {
  const parsed = parseCliArgs(args, {
    command: 'generate',
    valueFlags: ['schema', 'output', 'cpp-output', 'config', 'format'],
    booleanFlags: ['positional', 'check', 'help', 'h'],
  });
  const format = cliFormat(parsed.values.get('format'), 'generate');
  const help = parsed.flags.has('help') || parsed.flags.has('h');
  return {
    ...(parsed.values.get('schema') ? { schemaPath: parsed.values.get('schema') } : {}),
    ...(parsed.values.get('output') ? { outputPath: parsed.values.get('output') } : {}),
    ...(parsed.values.get('cpp-output') ? { cppOutputPath: parsed.values.get('cpp-output') } : {}),
    ...(parsed.values.get('config') ? { configPath: parsed.values.get('config') } : {}),
    ...(parsed.flags.has('positional') ? { positional: true } : {}),
    ...(parsed.flags.has('check') ? { check: true } : {}),
    ...(format ? { format } : {}),
    ...(help ? { help: true } : {}),
  };
}
