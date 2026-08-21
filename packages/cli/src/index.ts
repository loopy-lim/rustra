#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { watch, readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { PackageSchema } from './schema.js';
import {
  generateTypesTs,
  generateCommandsTs,
  generateEventsTs,
  generateContractTs,
  generateRkyvCodecsTs,
  generateRkyvRegistryTs,
  generateRkyvCodecsHpp,
  generateRkyvCodecsCpp,
  generatePositionalFacadeTs,
} from './generate.js';
import { diffSchemas, formatDiffResult } from './schema-diff.js';

export { generatePositionalFacadeTs };
export {
  generateTypesTs,
  generateCommandsTs,
  generateEventsTs,
  generateContractTs,
  generateRkyvCodecsTs,
  generateRkyvRegistryTs,
  generateRkyvCodecsHpp,
  generateRkyvCodecsCpp,
} from './generate.js';
export type { PackageSchema, CommandSchema, JsonSchema } from './schema.js';
export { diffSchemas, formatDiffResult } from './schema-diff.js';
export type { BreakingChange, DiffResult } from './schema-diff.js';
export { createValidatedEngine } from './validate-engine.js';
export type { EngineClient as ValidateEngineClient, ValidateOptions } from './validate-engine.js';
export { rustraPlugin } from './vite.js';
export type { RustraVitePluginOptions } from './vite.js';
export { parsePackageSchema };

/** dist 레이아웃: dist/index.js 와 package.json 이 같은 레벨(packages/cli)이다.
 * bin/main 모두 ./dist/index.js 이므로 require('../package.json') = packages/cli/package.json.
 * 읽기에 실패하면 조용히 넘기지 않고 즉시 throw — 잘못된 버전의 템플릿을
 * 생성하는 것보다 init 이 크게 실패하는 편이 낫다. */
const cliVersion: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/** init 템플릿의 버전 핀은 CLI 자체 버전에서 파생한다 — 워크스페이스 범프가
 * 템플릿에 자동 전파되도록(과거 ^0.1.3 고정으로 0.2.0 사용자가 구버전을
 * 설치하던 사고 방지). cargo 는 minor 범위(cargo 관례상 캐럿 불필요), npm 은
 * caret 정확 버전. */
export function templateVersions(cliVersion: string): {
  cargoMinor: string;
  npmCaret: string;
} {
  const minor = cliVersion.split('.').slice(0, 2).join('.');
  return { cargoMinor: minor, npmCaret: `^${cliVersion}` };
}

/** TS 식별자로 안전한 문자열만 허용 — 생성 코드에 그대로 삽입되는 이름의
 * 주입 방어. $ 허용은 JS 식별자 규격 준수. */
const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertIdentifier(value: string, where: string): void {
  if (!TS_IDENTIFIER.test(value)) {
    throw new Error(
      `Invalid schema: ${where} must be a plain identifier, got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * 스키마 트리 전체의 식별자 화이트리스트 — 코드젠이 식별자 위치(따옴표 없이
 * 방출하는 이름)에 삽입하는 모든 키를 검증한다:
 * - `definitions` 키(최상위 cmd.definitions 외에 inputSchema/outputSchema 내부,
 *   다른 definition 내부의 중첩 definitions 포함 — collectDefinitionsInner 가
 *   재귀 수집해 `export type ${name}` 으로 방출)
 * - `properties` 키(생성 TS 멤버 `${name}:`, rkyv 코덱 `args.${name}`,
 *   C++ `getProperty(rt, "${name}")` — 모두 무인용 방출)
 * - `$ref` 대상 타입명(resolveRef 로 벗겨 타입 위치에 방출)
 *
 * schemars/serde 는 Rust 필드명(식별자)만 내보내므로 정상 스키마는 영향 없다.
 * description/enum 값 등 자유 문자열은 여기서 거부하지 않는다 — 방출 시점
 * 이스케이프(codegen.ts escapeJsDoc/escapeStringLiteral)로 방어한다.
 */
function assertSchemaIdentifiers(
  schema: unknown,
  where: string,
  visited: Set<unknown> = new Set(),
): void {
  if (typeof schema !== 'object' || schema === null || visited.has(schema)) return;
  visited.add(schema);
  const node = schema as {
    definitions?: Record<string, unknown>;
    properties?: Record<string, unknown>;
    $ref?: unknown;
    [key: string]: unknown;
  };
  if (typeof node.$ref === 'string') {
    const target = node.$ref.replace(/^#\/(definitions\/|\$defs\/)/, '');
    assertIdentifier(target, `${where} $ref target`);
  }
  if (node.definitions) {
    for (const key of Object.keys(node.definitions)) {
      assertIdentifier(key, `${where} definitions key`);
      assertSchemaIdentifiers(node.definitions[key], `${where}.${key}`, visited);
    }
  }
  if (node.properties) {
    for (const key of Object.keys(node.properties)) {
      assertIdentifier(key, `${where} property name`);
      assertSchemaIdentifiers(node.properties[key], `${where}.${key}`, visited);
    }
  }
  // collectDefinitionsInner 의 순회와 동일한 하위 스키마 위치을 따라간다.
  for (const arrayKey of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
    const arr = node[arrayKey];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        assertSchemaIdentifiers(arr[i], `${where}.${arrayKey}[${i}]`, visited);
      }
    }
  }
  const items = node.items;
  if (Array.isArray(items)) {
    items.forEach((s, i) => assertSchemaIdentifiers(s, `${where}.items[${i}]`, visited));
  } else if (items) {
    assertSchemaIdentifiers(items, `${where}.items`, visited);
  }
  if (
    node.additionalProperties &&
    typeof node.additionalProperties === 'object' &&
    !Array.isArray(node.additionalProperties)
  ) {
    assertSchemaIdentifiers(node.additionalProperties, `${where}.additionalProperties`, visited);
  }
}

/** import 로 main() 이 실행되지 않도록 진입점 판별 — 테스트가 ./index.js 를
 * import 해도 CLI 가 실행되지 않는다. bin 스크립트(node dist/index.js)와
 * `node src/index.ts` 직접 실행 양쪽 모두 진입점으로 취급한다. */
function isCliEntry(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

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

  if (args[0] === 'init') {
    await runInit(args.slice(1));
    return;
  }

  if (args[0] === 'diff') {
    await runDiff(args.slice(1));
    return;
  }

  if (args[0] === 'dev') {
    const { runDev } = await import('./dev.js');
    await runDev(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${args[0]}`);
  console.error('Run "rustra --help" for usage information.');
  process.exit(1);
}

/**
 * `rustra diff --old a.json --new b.json [--format json]` — 스키마 버전 간
 * breaking change 검출. breaking 이 있으면 exit 1 (CI 게이트용).
 */
async function runDiff(args: string[]): Promise<void> {
  const getOpt = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const oldPath = getOpt('old');
  const newPath = getOpt('new');
  const asJson = args.includes('--format') && args[args.indexOf('--format') + 1] === 'json';

  if (!oldPath || !newPath) {
    console.error(
      'Error: --old and --new are required. Usage: rustra diff --old v1.json --new v2.json',
    );
    process.exit(1);
  }

  const [oldRaw, newRaw] = await Promise.all([
    readFile(resolve(oldPath), 'utf-8'),
    readFile(resolve(newPath), 'utf-8'),
  ]);
  const result = diffSchemas(
    parsePackageSchema(JSON.parse(oldRaw)),
    parsePackageSchema(JSON.parse(newRaw)),
  );

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDiffResult(result));
    if (result.compatible.length > 0) {
      console.log(`Compatible additions (${result.compatible.length}):`);
      for (const c of result.compatible) console.log(`  + ${c}`);
    }
  }

  if (result.breaking.length > 0) process.exit(1);
}

/**
 * `rustra init <dir>` — 프로젝트 스캐폴딩.
 *
 * 최소 동작 구조를 생성한다: Cargo 크레이트(의존성은 버전 지정 — crates.io 발행 기준),
 * main.rs 에 `generate_typescript` bin 골격, package.json(codegen 스크립트),
 * rustra.json(CLI 설정). 빌드/실행은 사용자 환경에서 `cargo add` 후 진행.
 */
async function runInit(args: string[]): Promise<void> {
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir) {
    console.error('Error: Provide a project directory. Usage: rustra init my-project');
    process.exit(1);
  }
  const root = resolve(dir);
  const v = templateVersions(cliVersion);

  const cargoToml = `# Generated by rustra init — adjust name/edition as needed.
[package]
name = "rustra-app"
version = "0.1.0"
edition = "2021"
publish = false
default-run = "rustra-app"

[dependencies]
rustra = "${v.cargoMinor}"
rustra-macros = "${v.cargoMinor}"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
schemars = "0.8"

[[bin]]
name = "generate"
path = "src/bin/generate.rs"
`;

  const mainRs = `use rustra::prelude::*;

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoInput {
    pub message: String,
}

#[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoOutput {
    pub message: String,
}

#[rustra::command]
fn echo(input: EchoInput) -> Result<EchoOutput> {
    Ok(EchoOutput {
        message: input.message,
    })
}

fn main() {
    let package = rustra::Package::builder("app.demo").command_fn(echo).build();
    let generated = package.generate_typescript().unwrap();
    generated.write_to_dir("generated").unwrap();
    println!("generated/ written — run the TS client from package.json");
}
`;

  const binRs = `fn main() {
    // 크레이트 루트의 generate_typescript 호출을 bin 에서 재사용하려면
    // lib.rs 로 추출하세요. 초기 스캐폴드는 main.rs 단일 파일 기준.
    println!("see src/main.rs — cargo run generates ./generated");
}
`;

  const pkgJson = `{
  "name": "rustra-app",
  "private": true,
  "type": "module",
  "scripts": {
    "codegen": "cargo run --bin generate && rustra generate --schema generated/schema.json --output src/generated"
  },
  "devDependencies": {
    "@rustra/cli": "${v.npmCaret}",
    "@rustra/types": "${v.npmCaret}"
  }
}
`;

  const rustraJson = `{
  "schema": "../generated/schema.json",
  "output": "../src/generated"
}
`;

  await mkdir(resolve(root, 'src/bin'), { recursive: true });
  await writeFile(resolve(root, 'Cargo.toml'), cargoToml);
  await writeFile(resolve(root, 'src/main.rs'), mainRs);
  await writeFile(resolve(root, 'src/bin/generate.rs'), binRs);
  await writeFile(resolve(root, 'package.json'), pkgJson);
  await writeFile(resolve(root, 'rustra.json'), rustraJson);

  console.log(`Created rustra project in ${root}:`);
  console.log('  Cargo.toml, src/main.rs, src/bin/generate.rs, package.json, rustra.json');
  console.log('\nNext steps:');
  console.log('  cd ' + dir);
  console.log('  cargo run            # generates ./generated (schema + TS)');
  console.log('  npm install && npm run codegen');
}

function printHelp(): void {
  console.log(`rustra - TypeScript code generation for rustra-bridge

Usage:
  rustra generate --schema <path> --output <dir>
  rustra generate --schema <path> --output <dir> --cpp-output <dir>
  rustra generate --config <path>
  rustra generate --watch --schema <path> --output <dir>
  rustra init <dir>
  rustra diff --old <schema.v1.json> --new <schema.json> [--format json]
  rustra dev [--backend <dir>] [--app <dir>]

Options:
  --schema <path>    Path to schema.json file
  --output <dir>     Output directory for generated TypeScript files
  --cpp-output <dir> Optional: also emit C++ codec (rustra-generated-codecs.{hpp,cpp})
                    for the RN JSI fast path (B1) into this directory
  --positional       Also emit positional-facade.ts (P2) — direct invokeTyped wrappers
  --config <path>    Path to rustra.json config file
  --watch            Watch schema file for changes and regenerate
  --old <path>       (diff) old schema version to compare from
  --new <path>       (diff) new schema version to compare against
  --format <fmt>     (diff) 'text' (default) or 'json' (machine-readable DiffResult)
  --backend <dir>    (dev) Rust backend crate dir (default: ./backend)
  --app <dir>        (dev) App dir containing generated/ (default: ./app)
  --inspect          (dev) codegen tick 후 @rustra/devtools 계측 안내 출력
  --help, -h         Show this help message

Examples:
  rustra generate --schema ./generated/schema.json --output ./src/generated
  rustra generate --watch --config rustra.json
  rustra generate --schema ./gen/schema.json --output ./src/generated --cpp-output ./ios
  rustra diff --old ./generated/schema.v1.json --new ./generated/schema.json
  rustra dev --backend ./backend --app ./app
`);
}

interface GenerateOptions {
  schemaPath?: string;
  outputPath?: string;
  configPath?: string;
  cppOutputPath?: string;
  /** (P2) positional-facade.ts 추가 생성 — RN JSI invokeTyped 직접 호출 래퍼. */
  positional?: boolean;
}

export async function runGenerate(args: string[]): Promise<void> {
  autoRebuild();
  const { schemaPath, outputPath, cppOutputPath, positional } = resolvePaths(args);
  const written = await generateFromSchema(schemaPath, outputPath, cppOutputPath, positional);
  console.log(`Generated TypeScript files in ${outputPath}:`);
  for (const f of written) console.log(`  ${f}`);
}

function resolvePaths(args: string[]): {
  schemaPath: string;
  outputPath: string;
  cppOutputPath?: string;
  positional?: boolean;
} {
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

  return {
    schemaPath: resolve(schemaPath),
    outputPath: resolve(outputPath),
    cppOutputPath: options.cppOutputPath ? resolve(options.cppOutputPath) : undefined,
    positional: options.positional,
  };
}

async function runWatch(args: string[]): Promise<void> {
  const { schemaPath, outputPath, cppOutputPath } = resolvePaths(args);

  await generateFromSchema(schemaPath, outputPath, cppOutputPath);
  console.log(`\nWatching ${schemaPath} for changes...`);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  watch(dirname(schemaPath), (_event, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        await generateFromSchema(schemaPath, outputPath, cppOutputPath);
        console.log(`[${new Date().toLocaleTimeString()}] Regenerated`);
      } catch (error) {
        console.error(`Regeneration failed: ${error instanceof Error ? error.message : error}`);
      }
    }, 100);
  });
}

async function generateFromSchema(
  schemaPath: string,
  outputPath: string,
  cppOutputPath?: string,
  positional = false,
): Promise<string[]> {
  const schemaContent = await readFile(schemaPath, 'utf-8');
  const schema: PackageSchema = parsePackageSchema(JSON.parse(schemaContent));

  // 필드 순서 일관성 경고 — properties 가 알파벳 순으로 정렬돼 있으면 postcard
  // 선언 순서 가정이 깨질 가능성이 있다(과거 schemars 비-preserve_order 산출물).
  // 단순 우연 정렬(calculator 의 a,b 같은 짧은 세트)은 흔하므로, 스키마 전체에서
  // 정렬 징후가 반복될 때(≥3개 명령) 한 번만 요약 경고를 낸다.
  let sortedFieldSuspects = 0;
  for (const command of schema.commands) {
    for (const s of [command.inputSchema, command.outputSchema]) {
      const names = Object.keys(s.properties ?? {});
      const sorted = [...names].sort();
      if (names.length > 1 && JSON.stringify(names) === JSON.stringify(sorted)) {
        sortedFieldSuspects++;
      }
    }
  }
  if (sortedFieldSuspects >= 3) {
    console.warn(
      `[rustra] WARN: ${sortedFieldSuspects} field sets appear alphabetically sorted; ` +
        `postcard encodes in Rust declaration order — verify the schema was generated with ` +
        `schemars/serde preserve_order enabled, or wire bytes may drift.`,
    );
  }

  const files: { name: string; content: string }[] = [
    { name: 'types.ts', content: generateTypesTs(schema) },
    { name: 'commands.ts', content: generateCommandsTs(schema) },
    { name: 'contract.ts', content: generateContractTs(schemaContent) },
    { name: 'rkyv-codecs.ts', content: generateRkyvCodecsTs(schema) },
    { name: 'rkyv-registry.ts', content: generateRkyvRegistryTs(schema) },
  ];

  // (이벤트 계약) 선언된 이벤트가 있을 때만 events.ts 를 만든다 — 없으면
  // 산출물 목록이 기존과 동일(하위호환).
  const eventsTs = generateEventsTs(schema);
  if (eventsTs) {
    files.push({ name: 'events.ts', content: eventsTs });
  }

  if (positional) {
    files.push({ name: 'positional-facade.ts', content: generatePositionalFacadeTs(schema) });
  }

  if (cppOutputPath) {
    files.push({ name: 'rustra-generated-codecs.hpp', content: generateRkyvCodecsHpp(schema) });
    files.push({ name: 'rustra-generated-codecs.cpp', content: generateRkyvCodecsCpp(schema) });
  }

  const written: string[] = [];
  // TS 출력은 outputPath 로, C++ 출력은 cppOutputPath 로 분리.
  for (const { name, content } of files) {
    const targetDir = name.endsWith('.hpp') || name.endsWith('.cpp') ? cppOutputPath! : outputPath;
    const filePath = resolve(targetDir, name);
    let existing: string | null = null;
    try {
      existing = await readFile(filePath, 'utf-8');
    } catch {
      /* file doesn't exist */
    }
    if (existing === content) {
      written.push(`${name} (unchanged)`);
    } else {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
      written.push(existing !== null ? `${name} (updated)` : name);
    }
  }
  if (cppOutputPath) {
    await mkdir(cppOutputPath, { recursive: true });
  }
  return written;
}

/**
 * Auto-rebuild the CLI if source files are newer than dist.
 * Prevents running a stale binary that generates outdated code.
 */
function autoRebuild(): void {
  try {
    const cliDir = resolve(dirname(new URL(import.meta.url).pathname), '..');
    const srcDir = resolve(cliDir, 'src');
    const distDir = resolve(cliDir, 'dist');

    let newestSrc = 0;
    let oldestDist = Infinity;
    const srcFiles = readdirSync(srcDir).filter((f: string) => f.endsWith('.ts'));
    for (const f of srcFiles) {
      const stat = statSync(resolve(srcDir, f));
      if (stat.mtimeMs > newestSrc) newestSrc = stat.mtimeMs;
    }
    try {
      const distFiles = readdirSync(distDir).filter((f: string) => f.endsWith('.js'));
      for (const f of distFiles) {
        const stat = statSync(resolve(distDir, f));
        if (stat.mtimeMs < oldestDist) oldestDist = stat.mtimeMs;
      }
    } catch {
      // dist doesn't exist yet — need build
      oldestDist = 0;
    }

    if (newestSrc > oldestDist) {
      console.log('CLI source is newer than dist — rebuilding...');
      execSync('npm run build', { cwd: cliDir, stdio: 'pipe' });
      console.log('CLI rebuilt.');
    }
  } catch {
    // Auto-rebuild is best-effort — don't block generate on failure
  }
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
      case '--cpp-output':
        options.cppOutputPath = args[++i];
        break;
      case '--config':
        options.configPath = args[++i];
        break;
      case '--positional':
        options.positional = true;
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
    // 식별자 화이트리스트 — name/inputType/outputType/definitions 키는 생성 TS 에
    // 그대로 삽입되므로 변조 schema.json 통한 코드 주입을 차단한다.
    // '()' 은 unit 타입 센티넬(generate.ts 의 `command.inputType !== '()'` 와 동일).
    assertIdentifier(cmd.name, `commands[${i}].name`);
    if (cmd.inputType !== '()') {
      assertIdentifier(cmd.inputType, `commands[${i}].inputType`);
    }
    if (cmd.outputType !== '()') {
      assertIdentifier(cmd.outputType, `commands[${i}].outputType`);
    }
    if (cmd.definitions) {
      for (const key of Object.keys(cmd.definitions)) {
        assertIdentifier(key, `commands[${i}].definitions key`);
      }
    }
    // 중첩 definitions 키 / 속성명 / $ref 대상도 재귀 검증 — collectDefinitionsInner
    // 가 수집하는 모든 정의와 tsObjectFromSchema 가 무인용 방출하는 모든 필드명.
    assertSchemaIdentifiers(cmd.inputSchema, `commands[${i}].inputSchema`);
    assertSchemaIdentifiers(cmd.outputSchema, `commands[${i}].outputSchema`);
    if (cmd.definitions) {
      for (const [key, def] of Object.entries(cmd.definitions)) {
        assertSchemaIdentifiers(def, `commands[${i}].definitions.${key}`);
      }
    }
  }
  return value as PackageSchema;
}

if (isCliEntry()) {
  main().catch((error) => {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
