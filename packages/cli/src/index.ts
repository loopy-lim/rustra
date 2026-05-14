#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { watch, readFileSync } from 'node:fs';
import type { PackageSchema } from './schema.js';
import { generateTypesTs, generateCommandsTs, generateContractTs, generateRkyvCodecsTs, generateRkyvRegistryTs } from './generate.js';

export { generateTypesTs, generateCommandsTs, generateContractTs, generateRkyvCodecsTs, generateRkyvRegistryTs } from './generate.js';
export type { PackageSchema, CommandSchema, JsonSchema } from './schema.js';
export { diffSchemas, formatDiffResult } from './schema-diff.js';
export type { BreakingChange, DiffResult } from './schema-diff.js';
export { createValidatedEngine } from './validate-engine.js';
export type { EngineClient as ValidateEngineClient, ValidateOptions } from './validate-engine.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  if (args[0] === 'generate') {
    const rest = args.slice(1);
    if (rest.includes('--watch')) {
      await runWatch(rest.filter((a) => a !== '--watch'));
      return;
    }
    await runGenerate(rest);
    return;
  }

  console.error(`Unknown command: ${args[0]}`);
  console.error('Run "rustra --help" for usage information.');
  process.exit(1);
}

function printHelp(): void {
  console.log(`rustra - TypeScript code generation for rustra-bridge

Usage:
  rustra generate --schema <path> --output <dir>
  rustra generate --config <path>
  rustra generate --watch --schema <path> --output <dir>

Options:
  --schema <path>   Path to schema.json file
  --output <dir>    Output directory for generated TypeScript files
  --config <path>   Path to rustra.json config file
  --watch           Watch schema file for changes and regenerate
  --help, -h        Show this help message

Examples:
  rustra generate --schema ./generated/schema.json --output ./src/generated
  rustra generate --watch --config rustra.json
`);
}

interface GenerateOptions {
  schemaPath?: string;
  outputPath?: string;
  configPath?: string;
}

async function runGenerate(args: string[]): Promise<void> {
  const { schemaPath, outputPath } = resolvePaths(args);
  await generateFromSchema(schemaPath, outputPath);
  console.log(`Generated TypeScript files in ${outputPath}:`);
  console.log('  types.ts');
  console.log('  commands.ts');
  console.log('  contract.ts');
  console.log('  rkyv-codecs.ts');
  console.log('  rkyv-registry.ts');
}

function resolvePaths(args: string[]): { schemaPath: string; outputPath: string } {
  const options = parseGenerateArgs(args);

  let schemaPath: string;
  let outputPath: string;

  if (options.configPath) {
    const config = readConfigSync(options.configPath);
    schemaPath = resolve(dirname(options.configPath), config.schema);
    outputPath = resolve(dirname(options.configPath), config.output);
  } else if (options.schemaPath && options.outputPath) {
    schemaPath = options.schemaPath;
    outputPath = options.outputPath;
  } else {
    console.error('Error: Provide --schema and --output, or --config with a config file.');
    process.exit(1);
  }

  return { schemaPath: resolve(schemaPath), outputPath: resolve(outputPath) };
}

async function runWatch(args: string[]): Promise<void> {
  const { schemaPath, outputPath } = resolvePaths(args);

  await generateFromSchema(schemaPath, outputPath);
  console.log(`\nWatching ${schemaPath} for changes...`);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  watch(dirname(schemaPath), (_event, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        await generateFromSchema(schemaPath, outputPath);
        console.log(`[${new Date().toLocaleTimeString()}] Regenerated`);
      } catch (error) {
        console.error(`Regeneration failed: ${error instanceof Error ? error.message : error}`);
      }
    }, 100);
  });
}

async function generateFromSchema(schemaPath: string, outputPath: string): Promise<void> {
  const schemaContent = await readFile(schemaPath, 'utf-8');
  const schema: PackageSchema = parsePackageSchema(JSON.parse(schemaContent));

  const typesTs = generateTypesTs(schema);
  const commandsTs = generateCommandsTs(schema);
  const contractTs = generateContractTs(schemaContent);
  const rkyvCodecsTs = generateRkyvCodecsTs(schema);
  const rkyvRegistryTs = generateRkyvRegistryTs(schema);

  await mkdir(outputPath, { recursive: true });
  await writeFile(resolve(outputPath, 'types.ts'), typesTs);
  await writeFile(resolve(outputPath, 'commands.ts'), commandsTs);
  await writeFile(resolve(outputPath, 'contract.ts'), contractTs);
  await writeFile(resolve(outputPath, 'rkyv-codecs.ts'), rkyvCodecsTs);
  await writeFile(resolve(outputPath, 'rkyv-registry.ts'), rkyvRegistryTs);
}

function parseGenerateArgs(args: string[]): GenerateOptions {
  const options: GenerateOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--schema':
        options.schemaPath = args[++i];
        break;
      case '--output':
        options.outputPath = args[++i];
        break;
      case '--config':
        options.configPath = args[++i];
        break;
    }
  }

  return options;
}

interface RustraConfig {
  schema: string;
  output: string;
}

function readConfigSync(configPath: string): RustraConfig {
  const content = readFileSync(resolve(configPath), 'utf-8');
  const config = JSON.parse(content) as RustraConfig;

  if (!config.schema || !config.output) {
    throw new Error(
      'Config file must have "schema" and "output" fields. Example:\n' +
        '{\n  "schema": "./generated/schema.json",\n  "output": "./src/generated"\n}',
    );
  }

  return config;
}

function parsePackageSchema(value: unknown): PackageSchema {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid schema: expected an object');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.packageId !== 'string') {
    throw new Error('Invalid schema: missing or invalid "packageId"');
  }
  if (!Array.isArray(obj.commands)) {
    throw new Error('Invalid schema: missing or invalid "commands" array');
  }
  for (let i = 0; i < obj.commands.length; i++) {
    const cmd = obj.commands[i] as Record<string, unknown>;
    if (typeof cmd.name !== 'string') {
      throw new Error(`Invalid schema: commands[${i}].name must be a string`);
    }
    if (typeof cmd.inputType !== 'string' || typeof cmd.outputType !== 'string') {
      throw new Error(`Invalid schema: commands[${i}] must have inputType and outputType`);
    }
    if (typeof cmd.inputSchema !== 'object' || typeof cmd.outputSchema !== 'object') {
      throw new Error(`Invalid schema: commands[${i}] must have inputSchema and outputSchema`);
    }
  }
  return value as PackageSchema;
}

main().catch((error) => {
  console.error('Error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
