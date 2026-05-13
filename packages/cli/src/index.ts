#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { PackageSchema } from "./schema.js";
import {
  generateTypesTs,
  generateCommandsTs,
  generateContractTs,
} from "./generate.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
  }

  if (args[0] === "generate") {
    await runGenerate(args.slice(1));
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

Options:
  --schema <path>   Path to schema.json file
  --output <dir>    Output directory for generated TypeScript files
  --config <path>   Path to rustra.json config file
  --help, -h        Show this help message

Examples:
  rustra generate --schema ./generated/schema.json --output ./src/generated
  rustra generate --config rustra.json
`);
}

interface GenerateOptions {
  schemaPath?: string;
  outputPath?: string;
  configPath?: string;
}

async function runGenerate(args: string[]): Promise<void> {
  const options = parseGenerateArgs(args);

  let schemaPath: string;
  let outputPath: string;

  if (options.configPath) {
    const config = await readConfig(options.configPath);
    schemaPath = resolve(dirname(options.configPath), config.schema);
    outputPath = resolve(dirname(options.configPath), config.output);
  } else if (options.schemaPath && options.outputPath) {
    schemaPath = options.schemaPath;
    outputPath = options.outputPath;
  } else {
    console.error(
      "Error: Provide --schema and --output, or --config with a config file.",
    );
    process.exit(1);
  }

  schemaPath = resolve(schemaPath);
  outputPath = resolve(outputPath);

  const schemaContent = await readFile(schemaPath, "utf-8");
  const schema: PackageSchema = JSON.parse(schemaContent);

  const typesTs = generateTypesTs(schema);
  const commandsTs = generateCommandsTs(schema);
  const contractTs = generateContractTs(schemaContent);

  await mkdir(outputPath, { recursive: true });
  await writeFile(resolve(outputPath, "types.ts"), typesTs);
  await writeFile(resolve(outputPath, "commands.ts"), commandsTs);
  await writeFile(resolve(outputPath, "contract.ts"), contractTs);

  console.log(`Generated TypeScript files in ${outputPath}:`);
  console.log("  types.ts");
  console.log("  commands.ts");
  console.log("  contract.ts");
}

function parseGenerateArgs(args: string[]): GenerateOptions {
  const options: GenerateOptions = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--schema":
        options.schemaPath = args[++i];
        break;
      case "--output":
        options.outputPath = args[++i];
        break;
      case "--config":
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

async function readConfig(configPath: string): Promise<RustraConfig> {
  const content = await readFile(resolve(configPath), "utf-8");
  const config = JSON.parse(content) as RustraConfig;

  if (!config.schema || !config.output) {
    throw new Error(
      'Config file must have "schema" and "output" fields. Example:\n' +
        '{\n  "schema": "./generated/schema.json",\n  "output": "./src/generated"\n}',
    );
  }

  return config;
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
